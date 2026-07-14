#!/usr/bin/env python3
"""Compare LLM-as-Judge results between two smoke-test arms.

Reads every judge JSON file produced by the smoke-test harness for two arms
(by default converter-ad-hoc and converter-workflow), aggregates the overall
and per-dimension scores, and reports descriptive statistics plus simple
significance tests.

Design notes.
  - When scipy is importable the Welch t-test and the Mann-Whitney U test use
    scipy.stats, which gives the exact t tail and, for the sample sizes here,
    the exact Mann-Whitney distribution with a tie correction. The script
    prints which backend produced the p-values.
  - When scipy is not importable the script falls back to standard library
    implementations of both tests. In that mode the t-test p-value uses the
    regularized incomplete beta function via a continued fraction, and the
    Mann-Whitney U test uses the normal approximation with a continuity
    correction. Those fallback p-values are approximate. Treat them as
    indicative, not exact.
  - Cohen's d is computed directly in either mode.
  - Across the ten dimension tests the script reports Benjamini-Hochberg false
    discovery rate q-values and Holm-Bonferroni family-wise adjusted p-values.
    The overall score and the pending rate are reported outside this corrected
    family, since overall is a weighted composite of the dimensions and pending
    is derived from the task summary.
  - The script also reports a percentile bootstrap 95 percent confidence
    interval for the difference in means, using a fixed seed so the interval is
    reproducible.

Usage.
  python3 compare_judge_results.py \
    --ad-hoc  <path to converter-ad-hoc/judge> \
    --workflow <path to converter-workflow/judge> \
    [--markdown <output .md path>] [--csv <output .csv path>]

If no paths are given the script falls back to the smoke_tests folders that sit
two levels above this script.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import statistics
import sys
from datetime import datetime, timezone

try:
    from scipy import stats as _scipy_stats
    HAVE_SCIPY = True
except ImportError:
    _scipy_stats = None
    HAVE_SCIPY = False

# The ten scored dimensions the judge emits, in the order used for reporting.
DIMENSIONS = [
    "task_completion",
    "code_correctness",
    "test_coverage",
    "code_quality",
    "instruction_adherence",
    "verification",
    "error_recovery",
    "decomposition_quality",
    "safety",
    "hygiene",
]


# ---------------------------------------------------------------------------
# Statistics helpers (standard library only).
# ---------------------------------------------------------------------------

def _betacf(a, b, x):
    """Continued fraction for the incomplete beta function (Numerical Recipes)."""
    max_iter = 200
    eps = 3.0e-12
    fpmin = 1.0e-300
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < fpmin:
        d = fpmin
    d = 1.0 / d
    h = d
    for m in range(1, max_iter + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < eps:
            break
    return h


def _betai(a, b, x):
    """Regularized incomplete beta function I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbeta = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
    bt = math.exp(lbeta + a * math.log(x) + b * math.log(1.0 - x))
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


def _t_sf_two_sided(t, df):
    """Two-sided p-value for a t statistic with df degrees of freedom."""
    if df <= 0:
        return float("nan")
    x = df / (df + t * t)
    return _betai(df / 2.0, 0.5, x)


def _normal_sf(z):
    """Upper-tail probability of the standard normal distribution."""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def _welch_t_test_fallback(a, b):
    """Standard library Welch's unequal-variance t-test. Returns (t, df, two_sided_p).

    The p-value uses the regularized incomplete beta tail and is approximate.
    """
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return float("nan"), float("nan"), float("nan")
    ma, mb = statistics.mean(a), statistics.mean(b)
    va, vb = statistics.variance(a), statistics.variance(b)
    if va == 0.0 and vb == 0.0:
        # Identical constants -> no difference; distinct constants -> infinite t.
        return (0.0, float(na + nb - 2), 1.0) if ma == mb else (
            float("inf"), float(na + nb - 2), 0.0)
    se = math.sqrt(va / na + vb / nb)
    if se == 0.0:
        return float("inf"), float(na + nb - 2), 0.0
    t = (ma - mb) / se
    num = (va / na + vb / nb) ** 2
    den = (va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1)
    df = num / den if den > 0 else float(na + nb - 2)
    return t, df, _t_sf_two_sided(t, df)


def welch_t_test(a, b):
    """Welch's unequal-variance t-test. Returns (t, df, two_sided_p).

    Uses scipy.stats.ttest_ind with equal_var False when scipy is available,
    which gives the exact t tail. Falls back to the standard library
    implementation otherwise.
    """
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return float("nan"), float("nan"), float("nan")
    if HAVE_SCIPY:
        res = _scipy_stats.ttest_ind(a, b, equal_var=False)
        df = getattr(res, "df", float("nan"))
        return float(res.statistic), float(df), float(res.pvalue)
    return _welch_t_test_fallback(a, b)


def _mann_whitney_u_fallback(a, b):
    """Standard library Mann-Whitney U test, normal approximation with tie and
    continuity correction. Returns (U, two_sided_p). The p-value is approximate."""
    na, nb = len(a), len(b)
    if na == 0 or nb == 0:
        return float("nan"), float("nan")
    combined = [(v, 0) for v in a] + [(v, 1) for v in b]
    combined.sort(key=lambda p: p[0])
    # Assign average ranks, tracking tie group sizes for the variance correction.
    ranks = [0.0] * len(combined)
    tie_terms = 0.0
    i = 0
    while i < len(combined):
        j = i
        while j + 1 < len(combined) and combined[j + 1][0] == combined[i][0]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0  # ranks are 1-based
        for k in range(i, j + 1):
            ranks[k] = avg_rank
        t = j - i + 1
        tie_terms += t ** 3 - t
        i = j + 1
    r1 = sum(rank for rank, (_, grp) in zip(ranks, combined) if grp == 0)
    u1 = r1 - na * (na + 1) / 2.0
    u2 = na * nb - u1
    u = min(u1, u2)
    n = na + nb
    mu = na * nb / 2.0
    sigma_sq = (na * nb / 12.0) * ((n + 1) - tie_terms / (n * (n - 1)))
    if sigma_sq <= 0:
        return u, float("nan")
    sigma = math.sqrt(sigma_sq)
    z = (abs(u - mu) - 0.5) / sigma  # continuity correction
    p = 2.0 * _normal_sf(z)
    return u, min(1.0, p)


def mann_whitney_u(a, b):
    """Mann-Whitney U test. Returns (U, two_sided_p).

    Uses scipy.stats.mannwhitneyu when scipy is available. For the sample sizes
    here scipy computes the exact distribution and applies a tie correction.
    Falls back to the standard library normal approximation otherwise.
    """
    na, nb = len(a), len(b)
    if na == 0 or nb == 0:
        return float("nan"), float("nan")
    if HAVE_SCIPY:
        # Use the exact method when there are no ties, otherwise the asymptotic
        # method, which applies scipy's tie correction. scipy raises if exact is
        # requested with ties present.
        has_ties = len(set(a) | set(b)) < (len(a) + len(b))
        method = "asymptotic" if has_ties else "exact"
        res = _scipy_stats.mannwhitneyu(a, b, alternative="two-sided", method=method)
        return float(res.statistic), float(res.pvalue)
    return _mann_whitney_u_fallback(a, b)


def cohens_d(a, b):
    """Cohen's d with a pooled standard deviation."""
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return float("nan")
    ma, mb = statistics.mean(a), statistics.mean(b)
    va, vb = statistics.variance(a), statistics.variance(b)
    pooled = ((na - 1) * va + (nb - 1) * vb) / (na + nb - 2)
    if pooled == 0.0:
        return 0.0 if ma == mb else float("inf")
    return (ma - mb) / math.sqrt(pooled)


def describe(values):
    """Descriptive statistics for a list of numbers."""
    if not values:
        return dict(n=0, mean=float("nan"), sd=float("nan"),
                    median=float("nan"), min=float("nan"), max=float("nan"))
    return dict(
        n=len(values),
        mean=statistics.mean(values),
        sd=statistics.stdev(values) if len(values) > 1 else 0.0,
        median=statistics.median(values),
        min=min(values),
        max=max(values),
    )


def benjamini_hochberg(pvals):
    """Benjamini-Hochberg false discovery rate adjusted q-values.

    The input is a list of p-values that may contain nan. nan entries are left
    out of the ranking and returned as nan. The returned list matches the input
    order. The adjusted values are made monotone from the largest rank down.
    """
    indexed = [(i, p) for i, p in enumerate(pvals)
               if isinstance(p, float) and not math.isnan(p)]
    q = [float("nan")] * len(pvals)
    m = len(indexed)
    if m == 0:
        return q
    indexed.sort(key=lambda t: t[1])
    prev = 1.0
    for rank in range(m, 0, -1):
        i, p = indexed[rank - 1]
        val = min(prev, p * m / rank)
        q[i] = val
        prev = val
    return q


def holm_bonferroni(pvals):
    """Holm-Bonferroni family-wise error rate adjusted p-values.

    The input is a list of p-values that may contain nan. nan entries are left
    out of the ranking and returned as nan. The returned list matches the input
    order.
    """
    indexed = [(i, p) for i, p in enumerate(pvals)
               if isinstance(p, float) and not math.isnan(p)]
    adj = [float("nan")] * len(pvals)
    m = len(indexed)
    if m == 0:
        return adj
    indexed.sort(key=lambda t: t[1])
    prev = 0.0
    for rank in range(1, m + 1):
        i, p = indexed[rank - 1]
        val = min(1.0, max(prev, (m - rank + 1) * p))
        adj[i] = val
        prev = val
    return adj


def bootstrap_ci_mean_diff(a, b, n_boot=10000, alpha=0.05, seed=12345):
    """Percentile bootstrap confidence interval for the difference of means.

    Returns (low, high) for the quantity mean(b) minus mean(a). A fixed seed is
    used so the interval is reproducible, which matters given the determinism
    focus of this work.
    """
    if len(a) < 2 or len(b) < 2:
        return float("nan"), float("nan")
    rng = random.Random(seed)
    na, nb = len(a), len(b)
    diffs = []
    for _ in range(n_boot):
        ra = sum(a[rng.randrange(na)] for _ in range(na)) / na
        rb = sum(b[rng.randrange(nb)] for _ in range(nb)) / nb
        diffs.append(rb - ra)
    diffs.sort()
    lo = diffs[int((alpha / 2.0) * n_boot)]
    hi = diffs[int((1.0 - alpha / 2.0) * n_boot) - 1]
    return lo, hi


# ---------------------------------------------------------------------------
# Data loading.
# ---------------------------------------------------------------------------

def load_arm(judge_dir):
    """Load every judge JSON in a directory into a list of run records."""
    runs = []
    if not os.path.isdir(judge_dir):
        return runs
    for name in sorted(os.listdir(judge_dir)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(judge_dir, name)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            print(f"WARN: skipping {path}: {exc}", file=sys.stderr)
            continue
        overall = data.get("overall", {})
        scores = data.get("scores", {})
        task = data.get("task_summary", {})
        rec = {
            "file": name,
            "timestamp": data.get("timestamp"),
            "overall": overall.get("score"),
            "grade": overall.get("grade"),
            "pending": task.get("pending"),
            "completed": task.get("completed"),
            "failed": task.get("failed"),
        }
        for dim in DIMENSIONS:
            entry = scores.get(dim, {})
            rec[dim] = entry.get("score") if isinstance(entry, dict) else None
        runs.append(rec)
    return runs


def column(runs, key):
    """Extract a numeric column, dropping missing values."""
    return [r[key] for r in runs if isinstance(r.get(key), (int, float))]


# ---------------------------------------------------------------------------
# Reporting.
# ---------------------------------------------------------------------------

def fmt(x, nd=2):
    if isinstance(x, float) and (math.isnan(x)):
        return "n/a"
    if isinstance(x, float) and math.isinf(x):
        return "inf"
    if isinstance(x, float):
        return f"{x:.{nd}f}"
    return str(x)


def p_stars(p):
    if not isinstance(p, float) or math.isnan(p):
        return ""
    if p < 0.001:
        return "***"
    if p < 0.01:
        return "**"
    if p < 0.05:
        return "*"
    return ""


def build_report(ad_hoc_dir, wf_dir):
    """Assemble the full comparison as a dict of computed rows."""
    ad = load_arm(ad_hoc_dir)
    wf = load_arm(wf_dir)

    rows = []
    for key in ["overall"] + DIMENSIONS + ["pending"]:
        a = column(ad, key)
        b = column(wf, key)
        da, db = describe(a), describe(b)
        t, df, tp = welch_t_test(a, b)
        _, mp = mann_whitney_u(a, b)
        d = cohens_d(a, b)
        ci_lo, ci_hi = bootstrap_ci_mean_diff(a, b) if (a and b) else (
            float("nan"), float("nan"))
        rows.append({
            "metric": key,
            "adhoc": da,
            "workflow": db,
            "diff": (db["mean"] - da["mean"]) if (a and b) else float("nan"),
            "diff_ci_lo": ci_lo,
            "diff_ci_hi": ci_hi,
            "welch_t": t,
            "welch_df": df,
            "welch_p": tp,
            "mwu_p": mp,
            "cohens_d": d,
            "welch_bh": float("nan"),
            "welch_holm": float("nan"),
            "mwu_bh": float("nan"),
        })

    # Multiple-comparison correction across the ten dimension tests only. The
    # overall row is a weighted composite of the dimensions and the pending row
    # is derived from the task summary, so both sit outside the corrected family.
    dim_rows = [r for r in rows if r["metric"] in DIMENSIONS]
    welch_bh = benjamini_hochberg([r["welch_p"] for r in dim_rows])
    welch_holm = holm_bonferroni([r["welch_p"] for r in dim_rows])
    mwu_bh = benjamini_hochberg([r["mwu_p"] for r in dim_rows])
    for r, wbh, wholm, mbh in zip(dim_rows, welch_bh, welch_holm, mwu_bh):
        r["welch_bh"] = wbh
        r["welch_holm"] = wholm
        r["mwu_bh"] = mbh

    # Grade distribution.
    def grade_counts(runs):
        counts = {}
        for r in runs:
            g = r.get("grade")
            if g:
                counts[g] = counts.get(g, 0) + 1
        return counts

    # Fraction of runs that left work pending (the premature-stop failure mode).
    def pending_rate(runs):
        vals = [r["pending"] for r in runs if isinstance(r.get("pending"), (int, float))]
        if not vals:
            return float("nan"), 0
        incomplete = sum(1 for v in vals if v > 0)
        return incomplete / len(vals), incomplete

    return {
        "ad_hoc_dir": ad_hoc_dir,
        "wf_dir": wf_dir,
        "n_adhoc": len(ad),
        "n_wf": len(wf),
        "rows": rows,
        "adhoc_grades": grade_counts(ad),
        "wf_grades": grade_counts(wf),
        "adhoc_pending": pending_rate(ad),
        "wf_pending": pending_rate(wf),
        "adhoc_runs": ad,
        "wf_runs": wf,
    }


def print_console(rep):
    print("=" * 78)
    print("Judge results comparison: converter-ad-hoc vs converter-workflow")
    print("=" * 78)
    print(f"ad-hoc   runs: {rep['n_adhoc']}  ({rep['ad_hoc_dir']})")
    print(f"workflow runs: {rep['n_wf']}  ({rep['wf_dir']})")
    print()
    header = (f"{'metric':22} {'adhoc':>8} {'wf':>8} "
              f"{'diff':>7} {'95% CI':>16} {'d':>6} "
              f"{'welch_p':>9} {'welch_q':>9} {'mwu_p':>9}")
    print(header)
    print("-" * len(header))
    for row in rep["rows"]:
        ci = f"[{fmt(row['diff_ci_lo'])}, {fmt(row['diff_ci_hi'])}]"
        print(f"{row['metric']:22} "
              f"{fmt(row['adhoc']['mean']):>8} "
              f"{fmt(row['workflow']['mean']):>8} "
              f"{fmt(row['diff']):>7} "
              f"{ci:>16} "
              f"{fmt(row['cohens_d']):>6} "
              f"{fmt(row['welch_p'], 4):>7}{p_stars(row['welch_p']):<2} "
              f"{fmt(row['welch_bh'], 4):>7}{p_stars(row['welch_bh']):<2} "
              f"{fmt(row['mwu_p'], 4):>7}{p_stars(row['mwu_p']):<2}")
    print()
    print(f"ad-hoc grades  : {rep['adhoc_grades']}")
    print(f"workflow grades: {rep['wf_grades']}")
    ar, ac = rep["adhoc_pending"]
    wr, wc = rep["wf_pending"]
    print(f"ad-hoc   runs leaving work pending: {ac} ({fmt(ar*100,1)}%)")
    print(f"workflow runs leaving work pending: {wc} ({fmt(wr*100,1)}%)")
    print()
    print("95% CI is a percentile bootstrap interval for the difference in "
          "means (workflow minus ad-hoc), 10000 resamples, fixed seed. "
          "welch_q is the Benjamini-Hochberg false discovery rate q-value "
          "across the ten dimension tests. The overall and pending rows are "
          "outside that corrected family.")
    if HAVE_SCIPY:
        print("P-values from scipy.stats (Welch t-test, Mann-Whitney U, exact "
              "when untied). Significance markers: * p<0.05  ** p<0.01  *** p<0.001.")
    else:
        print("scipy not available. P-values are approximate (Welch t-test with "
              "an incomplete beta tail, Mann-Whitney U with a normal "
              "approximation). Significance markers: * p<0.05  ** p<0.01  *** p<0.001.")


def write_csv(rep, path):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["metric", "adhoc_n", "adhoc_mean", "adhoc_sd",
                    "wf_n", "wf_mean", "wf_sd", "diff",
                    "diff_ci_lo", "diff_ci_hi",
                    "cohens_d", "welch_t", "welch_df", "welch_p",
                    "welch_bh", "welch_holm", "mwu_p", "mwu_bh"])
        for row in rep["rows"]:
            a, b = row["adhoc"], row["workflow"]
            w.writerow([row["metric"], a["n"], fmt(a["mean"], 4), fmt(a["sd"], 4),
                        b["n"], fmt(b["mean"], 4), fmt(b["sd"], 4),
                        fmt(row["diff"], 4),
                        fmt(row["diff_ci_lo"], 4), fmt(row["diff_ci_hi"], 4),
                        fmt(row["cohens_d"], 4),
                        fmt(row["welch_t"], 4), fmt(row["welch_df"], 2),
                        fmt(row["welch_p"], 6), fmt(row["welch_bh"], 6),
                        fmt(row["welch_holm"], 6), fmt(row["mwu_p"], 6),
                        fmt(row["mwu_bh"], 6)])
    print(f"Wrote CSV: {path}")


def write_markdown(rep, path):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = []
    lines.append("<!-- Generated by scripts/compare_judge_results.py. Do not edit by hand. -->")
    lines.append("")
    lines.append("## Judge results summary")
    lines.append("")
    lines.append(f"Generated {now}. "
                 f"ad-hoc n = {rep['n_adhoc']}, workflow n = {rep['n_wf']}.")
    lines.append("")
    lines.append("| Metric | ad-hoc mean (sd) | workflow mean (sd) | diff | 95% CI | Cohen d | Welch p | Welch q | MWU p |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for row in rep["rows"]:
        a, b = row["adhoc"], row["workflow"]
        ci = f"[{fmt(row['diff_ci_lo'])}, {fmt(row['diff_ci_hi'])}]"
        lines.append(
            f"| {row['metric']} "
            f"| {fmt(a['mean'])} ({fmt(a['sd'])}) "
            f"| {fmt(b['mean'])} ({fmt(b['sd'])}) "
            f"| {fmt(row['diff'])} "
            f"| {ci} "
            f"| {fmt(row['cohens_d'])} "
            f"| {fmt(row['welch_p'], 4)}{p_stars(row['welch_p'])} "
            f"| {fmt(row['welch_bh'], 4)}{p_stars(row['welch_bh'])} "
            f"| {fmt(row['mwu_p'], 4)}{p_stars(row['mwu_p'])} |")
    lines.append("")
    lines.append(f"ad-hoc grades: {rep['adhoc_grades']}. "
                 f"workflow grades: {rep['wf_grades']}.")
    ar, ac = rep["adhoc_pending"]
    wr, wc = rep["wf_pending"]
    lines.append("")
    lines.append(f"Runs leaving work pending: ad-hoc {ac} of {rep['n_adhoc']} "
                 f"({fmt(ar*100,1)}%), workflow {wc} of {rep['n_wf']} ({fmt(wr*100,1)}%).")
    lines.append("")
    lines.append("The 95% CI is a percentile bootstrap interval for the "
                 "difference in means, workflow minus ad-hoc, over 10000 "
                 "resamples with a fixed seed. The Welch q column is the "
                 "Benjamini-Hochberg false discovery rate q-value across the ten "
                 "dimension tests. The overall and pending rows sit outside that "
                 "corrected family. Holm-Bonferroni adjusted p-values are in the "
                 "CSV output.")
    lines.append("")
    if HAVE_SCIPY:
        lines.append("Significance markers: * p<0.05, ** p<0.01, *** p<0.001. "
                     "The p-values come from scipy.stats, a Welch t-test and a "
                     "Mann-Whitney U test. The Mann-Whitney p-value is exact when "
                     "the samples have no ties and asymptotic with a tie "
                     "correction otherwise.")
    else:
        lines.append("Significance markers: * p<0.05, ** p<0.01, *** p<0.001. "
                     "scipy was not available, so the p-values are approximate "
                     "(Welch t-test with an incomplete beta tail, Mann-Whitney U "
                     "with a normal approximation).")
    lines.append("")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"Wrote Markdown: {path}")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    smoke = os.path.normpath(os.path.join(here, "..", "smoke_tests"))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ad-hoc", default=os.path.join(smoke, "converter-ad-hoc", "judge"),
                    help="Path to the converter-ad-hoc judge directory.")
    ap.add_argument("--workflow", default=os.path.join(smoke, "converter-workflow", "judge"),
                    help="Path to the converter-workflow judge directory.")
    ap.add_argument("--markdown", default=None, help="Optional Markdown output path.")
    ap.add_argument("--csv", default=None, help="Optional CSV output path.")
    args = ap.parse_args()

    rep = build_report(args.ad_hoc, args.workflow)
    if rep["n_adhoc"] == 0 and rep["n_wf"] == 0:
        print("ERROR: no judge JSON files found in either directory.", file=sys.stderr)
        return 1
    print_console(rep)
    if args.csv:
        write_csv(rep, args.csv)
    if args.markdown:
        write_markdown(rep, args.markdown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
