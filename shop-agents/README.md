# Shop Agents

This is the core implementation of the autonomous shopping agents.

## Quick Start

1. **Install dependencies:**
   ```bash
   uv sync
   uv run playwright install chromium
   ```

2. **Run Dagster:**
   ```bash
   uv run dg dev
   ```

## Key Components

- **Agents:** Defined in `shop_agents/agents/`. Uses CrewAI for decision making.
- **Orchestration:** Defined in `shop_agents/defs/`. Uses Dagster for lifecycle management.
- **Tools:** Defined in `shop_agents/tools/`. Uses Playwright for browser automation.

For full documentation, see [docs/project-guide.md](../docs/project-guide.md) in the project root.
