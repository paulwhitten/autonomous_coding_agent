# Docker Deployment for Autonomous Copilot Agent

This folder contains Docker deployment configuration for running the autonomous agent in containers while connecting to a Copilot CLI instance running on the host machine.

## Architecture

```
┌─────────────────────────┐
│   Host Machine          │
│                         │
│  ┌──────────────────┐   │
│  │  Copilot CLI     │   │
│  │  (port 3000)     │   │
│  │  - Authenticated │   │
│  │  - Single source │   │
│  └────────┬─────────┘   │
│           │             │
│           │ TCP         │
│  ┌────────┴─────────┐   │
│  │  Container(s)    │   │
│  │  - Agent code    │   │
│  │  - Workspace     │   │
│  │  - Logs          │   │
│  └──────────────────┘   │
└─────────────────────────┘
```

## Prerequisites

1. **Docker Desktop** (Mac/Windows) or **Docker Engine** (Linux)
2. **GitHub Copilot CLI** installed and authenticated on host
3. **Git** configured for mailbox repository access

## Quick Start

### 1. Start Copilot CLI on Host

First, start the Copilot CLI in server mode on your host machine:

```bash
# Terminal 1 - Start CLI server
copilot --port 3000 --server-mode
```

Keep this running. The CLI will handle all authentication and model requests.

### 2. Prepare Configuration

```bash
cd docker

# Create workspace and mailbox directories
mkdir -p workspace shared-mailbox logs

# Copy and customize config
cp config.json.example config.json
# Edit config.json with your settings
```

**Minimal `config.json`:**
```json
{
  "agent": {
    "hostname": "docker-agent",
    "role": "developer",
    "checkIntervalMs": 30000,
    "stuckTimeoutMs": 300000,
    "sdkTimeoutMs": 300000
  },
  "mailbox": {
    "repoPath": "/app/shared-mailbox",
    "gitSync": true,
    "autoCommit": true,
    "commitMessage": "Agent: {hostname}_{role} at {timestamp}",
    "supportBroadcast": true,
    "supportAttachments": true,
    "supportPriority": true
  },
  "copilot": {
    "model": "gpt-4.1",
    "allowedTools": ["all"]
  },
  "workspace": {
    "path": "/app/workspace",
    "persistContext": true
  },
  "logging": {
    "level": "info",
    "path": "/app/logs/agent.log",
    "maxSizeMB": 100
  },
  "manager": {
    "hostname": "localhost",
    "role": "manager",
    "escalationPriority": "NORMAL"
  }
}
```

### 3. Initialize Mailbox Repository

The mailbox must be a Git repository:

```bash
cd shared-mailbox

# Option A: Clone existing mailbox repo
git clone git@github.com:your-org/agent-mailbox.git .

# Option B: Initialize new repo
git init
mkdir -p mailbox/to_docker-agent_developer/{priority,normal,background}
mkdir -p mailbox/to_all
mkdir -p attachments
git add .
git commit -m "Initial mailbox structure"
```

### 4. Build and Run

```bash
# Build the Docker image (Node.js only — default)
docker-compose build

# Build with optional language toolchains
docker-compose build --build-arg INSTALL_PYTHON=true
docker-compose build --build-arg INSTALL_PYTHON=true --build-arg INSTALL_GO=true

# Build with all languages
docker-compose build \
  --build-arg INSTALL_PYTHON=true \
  --build-arg INSTALL_RUST=true \
  --build-arg INSTALL_GO=true \
  --build-arg INSTALL_JAVA=true

# Or uncomment the args in docker-compose.yml and just run:
# docker-compose build

# Start the agent
docker-compose up -d

# View logs
docker-compose logs -f agent
```

#### Available Build Args

| Arg | Default | Description |
|---|---|---|
| `INSTALL_PYTHON` | `false` | Python 3 + pip + venv (~150-200 MB) |
| `INSTALL_RUST` | `false` | Rust stable via rustup (~800 MB-1 GB) |
| `INSTALL_GO` | `false` | Go official tarball (~500-600 MB) |
| `INSTALL_JAVA` | `false` | OpenJDK 17 + Maven (~300-400 MB) |
| `GO_VERSION` | `1.23.6` | Go version (when `INSTALL_GO=true`) |

### 5. Stop the Agent

```bash
# Graceful shutdown
docker-compose down

# View final state
ls workspace/
cat workspace/session_context.json
```

## Platform-Specific Configuration

### Docker Desktop (Mac/Windows)

Default configuration works out of the box:
```yaml
environment:
  - COPILOT_CLI_URL=host.docker.internal:3000
```

### Linux with Bridge Network

Use `extra_hosts` (already configured in docker-compose.yml):
```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
environment:
  - COPILOT_CLI_URL=host.docker.internal:3000
```

### Linux with Host Network

Uncomment the `network_mode` setting:
```yaml
network_mode: "host"
environment:
  - COPILOT_CLI_URL=localhost:3000
```

## Git Authentication for Mailbox Sync

### Option 1: SSH Keys (Recommended)

Mount your SSH directory:
```yaml
volumes:
  - ~/.ssh:/root/.ssh:ro
```

Ensure your key is added to ssh-agent on host:
```bash
ssh-add ~/.ssh/id_rsa
```

### Option 2: HTTPS with Git Credentials

Create a `.git-credentials` file:
```
https://username:token@github.com
```

Mount it:
```yaml
volumes:
  - ./.git-credentials:/root/.git-credentials:ro
  - ~/.gitconfig:/root/.gitconfig:ro
```

Configure git credential helper in container:
```bash
docker-compose exec agent git config --global credential.helper store
```

## Running Multiple Agents

Edit `docker-compose.yml` and uncomment the multi-agent section:

```yaml
services:
  developer-agent:
    extends: agent
    container_name: copilot-developer
    volumes:
      - ./workspace-dev:/app/workspace
      - ./config-developer.json:/app/config.json:ro
  
  qa-agent:
    extends: agent
    container_name: copilot-qa
    volumes:
      - ./workspace-qa:/app/workspace
      - ./config-qa.json:/app/config.json:ro
```

All agents share:
- Same Copilot CLI connection (host:3000)
- Same mailbox repository
- Different workspaces

Start all agents:
```bash
docker-compose up -d developer-agent qa-agent
```

## Monitoring

### View logs
```bash
# Follow logs
docker-compose logs -f agent

# Last 100 lines
docker-compose logs --tail=100 agent

# Logs from mounted volume
tail -f logs/agent.log
```

### Check status
```bash
# Container status
docker-compose ps

# Session context
cat workspace/session_context.json

# Mailbox messages
ls -la shared-mailbox/mailbox/to_docker-agent_developer/normal/
```

### Resource usage
```bash
docker stats copilot-agent
```

## Troubleshooting

### Agent can't connect to CLI

**Error:** "Connection refused" or timeout

**Solutions:**
1. Check CLI is running: `curl http://localhost:3000/health` (if CLI exposes health endpoint)
2. Verify network connectivity:
   ```bash
   docker-compose exec agent ping host.docker.internal
   ```
3. Check firewall settings on host
4. Try host networking on Linux: `network_mode: "host"`

### Git authentication fails

**Error:** "Permission denied (publickey)" or "Authentication failed"

**Solutions:**
1. SSH: Check key is mounted and has correct permissions:
   ```bash
   docker-compose exec agent ls -la /root/.ssh/
   docker-compose exec agent ssh -T git@github.com
   ```
2. HTTPS: Verify credentials are mounted:
   ```bash
   docker-compose exec agent cat /root/.git-credentials
   ```

### Permission errors on volumes

**Error:** "EACCES: permission denied"

**Solution:** Fix ownership:
```bash
# On host
sudo chown -R $(id -u):$(id -g) workspace/ mailbox/ logs/

# Or run container with user
docker-compose exec --user $(id -u):$(id -g) agent sh
```

### Session won't resume

The agent automatically resumes sessions if `session_context.json` exists. If you want to force a new session:

```bash
rm workspace/session_context.json
docker-compose restart agent
```

## Backup and Recovery

### Backup persistent state
```bash
# Backup workspace (includes session context)
tar czf backup-workspace-$(date +%Y%m%d).tar.gz workspace/

# Backup mailbox
cd shared-mailbox && git bundle create ../backup-mailbox.bundle --all
```

### Restore from backup
```bash
# Restore workspace
tar xzf backup-workspace-20260206.tar.gz

# Restore mailbox
cd mailbox && git clone ../backup-mailbox.bundle .
```

## Production Considerations

1. **Resource Limits:** Add to docker-compose.yml:
   ```yaml
   deploy:
     resources:
       limits:
         cpus: '2'
         memory: 4G
   ```

2. **Log Rotation:** Configure pino or use Docker logging driver:
   ```yaml
   logging:
     driver: "json-file"
     options:
       max-size: "100m"
       max-file: "3"
   ```

3. **Health Checks:** Add health check:
   ```yaml
   healthcheck:
     test: ["CMD", "test", "-f", "/app/workspace/session_context.json"]
     interval: 30s
     timeout: 10s
     retries: 3
   ```

4. **Secrets Management:** Use Docker secrets instead of environment variables:
   ```yaml
   secrets:
     - github_token
   ```

5. **Monitoring:** Integrate with Prometheus/Grafana:
   - Export log metrics
   - Monitor container resources
   - Track mailbox processing rate

## Advanced Usage

### Custom CLI Port

If your CLI runs on a different port:
```yaml
environment:
  - COPILOT_CLI_URL=host.docker.internal:8080
```

### Override Config with Environment

Extend the agent code to support environment variable overrides:
```yaml
environment:
  - AGENT_HOSTNAME=production-agent
  - LOG_LEVEL=debug
  - CHECK_INTERVAL_MS=60000
```

### Development Mode with Hot Reload

For development, mount source code:
```yaml
volumes:
  - ../src:/app/src
command: npm run dev
```

## References

- [Copilot SDK Documentation](https://www.npmjs.com/package/@github/copilot-sdk)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [External Mailbox Protocol](../README.md)
