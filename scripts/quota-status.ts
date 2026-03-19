#!/usr/bin/env tsx
// Display current quota usage status

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface QuotaState {
  month: string;
  used: {
    monthly: number;
    today: number;
    byModel: Record<string, number>;
    byPriority: Record<string, number>;
  };
  lastReset: string;
  todayDate: string;
  warnings: string[];
}

async function main() {
  try {
    // Load config
    const configPath = path.resolve(__dirname, '../config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    
    // Load quota state
    const statePath = path.resolve(config.workspace.path, 'quota_state.json');
    let state: QuotaState;
    
    try {
      state = JSON.parse(await readFile(statePath, 'utf-8'));
    } catch (error) {
      console.log('⚠️  No quota state found - agent has not run yet\n');
      return;
    }
    
    // Load preset
    const presetsPath = path.resolve(__dirname, '../quota-presets.json');
    const presets = JSON.parse(await readFile(presetsPath, 'utf-8'));
    const presetName = config.quota?.preset || 'conservative';
    const preset = presets.presets[presetName];
    
    // Display header
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║              QUOTA STATUS REPORT                         ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    
    console.log(`📊 Agent: ${config.agent.hostname}_${config.agent.role}`);
    console.log(`📅 Month: ${state.month}`);
    console.log(`📆 Today: ${state.todayDate}\n`);
    
    // Monthly usage
    const monthlyLimit = preset.limits.monthly;
    const monthlyPct = monthlyLimit ? Math.round((state.used.monthly / monthlyLimit) * 100) : 0;
    console.log('═══ MONTHLY USAGE ═══');
    console.log(`Used: ${state.used.monthly}${monthlyLimit ? ` / ${monthlyLimit}` : ''} requests`);
    if (monthlyLimit) {
      console.log(`Progress: ${'█'.repeat(Math.floor(monthlyPct / 5))}${'░'.repeat(20 - Math.floor(monthlyPct / 5))} ${monthlyPct}%`);
    }
    console.log();
    
    // Daily usage
    const dailyLimit = preset.limits.daily;
    const dailyPct = dailyLimit ? Math.round((state.used.today / dailyLimit) * 100) : 0;
    console.log('═══ TODAY\'S USAGE ═══');
    console.log(`Used: ${state.used.today}${dailyLimit ? ` / ${dailyLimit}` : ''} requests`);
    if (dailyLimit) {
      console.log(`Progress: ${'█'.repeat(Math.floor(dailyPct / 5))}${'░'.repeat(20 - Math.floor(dailyPct / 5))} ${dailyPct}%`);
    }
    console.log();
    
    // By model
    if (Object.keys(state.used.byModel).length > 0) {
      console.log('═══ USAGE BY MODEL ═══');
      Object.entries(state.used.byModel)
        .sort(([, a], [, b]) => b - a)
        .forEach(([model, count]) => {
          console.log(`  ${model}: ${count} requests`);
        });
      console.log();
    }
    
    // By priority
    if (Object.keys(state.used.byPriority).length > 0) {
      console.log('═══ USAGE BY PRIORITY ═══');
      Object.entries(state.used.byPriority)
        .sort(([, a], [, b]) => b - a)
        .forEach(([priority, count]) => {
          console.log(`  ${priority}: ${count} requests`);
        });
      console.log();
    }
    
    // Warnings
    if (state.warnings.length > 0) {
      console.log('⚠️  WARNINGS:');
      state.warnings.forEach(warning => console.log(`  - ${warning}`));
      console.log();
    }
    
    // Config info
    console.log('═══ QUOTA CONFIGURATION ═══');
    console.log(`Preset: ${presetName}`);
    console.log(`Primary model: ${preset.modelFallback?.primary || config.copilot.model}`);
    console.log(`Fallback model: ${preset.modelFallback?.fallback || 'none'}`);
    console.log(`Fallback at: ${preset.modelFallback?.switchAt ? Math.round(preset.modelFallback.switchAt * 100) + '%' : 'disabled'}`);
    console.log();
    
    // Quota monitoring link
    console.log('🔗 Check GitHub quota: https://github.com/settings/billing');
    console.log();
    
  } catch (error) {
    console.error('❌ Error reading quota status:', error);
    process.exit(1);
  }
}

main();
