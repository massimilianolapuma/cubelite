# Penpot MCP Setup Guide

This guide explains how to set up and use the **Penpot MCP Server** for
design-to-code and code-to-design workflows in the CubeLite workspace.

CubeLite uses [Penpot](https://penpot.app/) (open-source design platform) with
the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) to enable
AI-powered design interactions directly from VS Code.

---

## Architecture

```
┌─────────────────┐     MCP (SSE)     ┌──────────────────┐
│  VS Code / LLM  │◄─────────────────►│  Penpot MCP      │
│  (MCP Client)   │   localhost:4401   │  Server           │
└─────────────────┘                    └────────┬─────────┘
                                                │ WebSocket
                                                │ localhost:4402
                                       ┌────────▼─────────┐
                                       │  Penpot MCP      │
                                       │  Plugin (browser) │
                                       └────────┬─────────┘
                                                │ Plugin API
                                       ┌────────▼─────────┐
                                       │     Penpot        │
                                       │  (design.penpot.app)│
                                       └──────────────────┘
```

The MCP server acts as a bridge between the LLM (via VS Code) and Penpot.
The Penpot MCP Plugin runs inside the browser and connects to the MCP server
via WebSocket, enabling the LLM to query, transform, and create design elements.

---

## Prerequisites

- **Node.js v22+** — required to run the MCP server
- **Browser** — to access Penpot and load the MCP plugin
- **Penpot account** — free at [design.penpot.app](https://design.penpot.app/)

---

## Quick Start

### 1. Start the MCP Server

The easiest way is using `npx` (no local install needed):

```bash
npx -y @penpot/mcp@">=0"
```

This starts both:
- **MCP Server** on `http://localhost:4401` (HTTP/SSE endpoints)
- **Plugin Server** on `http://localhost:4400` (serves the Penpot plugin)

### 2. Load the Plugin in Penpot

1. Open [design.penpot.app](https://design.penpot.app/) in your browser
2. Navigate to a design file
3. Open the **Plugins** menu
4. Load the plugin URL: `http://localhost:4400/manifest.json`
5. Open the plugin UI
6. Click **"Connect to MCP server"** — status should change to "Connected"

> **Important**: Do not close the plugin UI while using the MCP server.

> **Note (Chromium 142+)**: You may need to approve a local network access
> popup. In Brave, disable the Shield for the Penpot website.

### 3. VS Code Connection

The workspace is pre-configured in `.vscode/mcp.json` to connect automatically
via SSE on `localhost:4401`. Once the MCP server is running, VS Code will
discover all available Penpot MCP tools.

No additional setup is needed — just ensure the server is running before
starting a design workflow.

---

## Endpoints

| Endpoint | URL | Transport |
|---|---|---|
| Streamable HTTP | `http://localhost:4401/mcp` | Modern clients |
| SSE (legacy) | `http://localhost:4401/sse` | VS Code default |
| WebSocket | `ws://localhost:4402` | Plugin connection |
| Plugin manifest | `http://localhost:4400/manifest.json` | Browser plugin |

---

## Configuration

The MCP server can be configured via environment variables:

| Variable | Description | Default |
|---|---|---|
| `PENPOT_MCP_SERVER_PORT` | HTTP/SSE server port | `4401` |
| `PENPOT_MCP_WEBSOCKET_PORT` | WebSocket port (plugin) | `4402` |
| `PENPOT_MCP_REPL_PORT` | REPL port (dev/debug) | `4403` |
| `PENPOT_MCP_SERVER_HOST` | Server bind address | `localhost` |
| `PENPOT_MCP_LOG_LEVEL` | Log level (trace/debug/info/warn/error) | `info` |
| `PENPOT_MCP_LOG_DIR` | Log file directory | `logs` |

---

## VS Code MCP Configuration

The workspace config is at `.vscode/mcp.json`:

```json
{
  "servers": {
    "penpot": {
      "type": "sse",
      "url": "http://localhost:4401/sse",
      "environmentVariables": {
        "PENPOT_MCP_SERVER_PORT": "4401",
        "PENPOT_MCP_WEBSOCKET_PORT": "4402"
      }
    }
  }
}
```

---

## Capabilities

The Penpot MCP server provides tools for:

- **Querying designs** — read component data, properties, styles
- **Transforming elements** — modify positions, sizes, colors, text
- **Creating elements** — add shapes, frames, text, components
- **Code execution** — run arbitrary Plugin API code in the Penpot context

Tools are dynamically discovered via MCP protocol when the server is running.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| Plugin won't connect | Check that MCP server is running on port 4401 |
| Browser blocks connection | Approve local network access popup (Chromium 142+) |
| Tools not showing in VS Code | Ensure server is running, then reload VS Code window |
| WebSocket timeout | Check port 4402 is not blocked by firewall |

---

## References

- [Penpot MCP source](https://github.com/penpot/penpot/tree/develop/mcp)
- [Penpot Plugin API](https://penpot.dev/plugins/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Penpot MCP video playlist](https://www.youtube.com/playlist?list=PLgcCPfOv5v57SKMuw1NmS0-lkAXevpn10)
