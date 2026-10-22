# Run it with Docker

An [Analysis Workspace](analysis-workspaces.md) can also run on your own computer, over
a folder of your own data, from the same Docker image Cirro runs. Nothing leaves your
computer unless you [publish it to Cirro](analysis-workspaces.md#publish-to-cirro).

## Start it

With [Docker](https://www.docker.com/) installed, run:

```bash
docker run -d -p 8080:8888 \
  -v "$(pwd)/data":/data -e SDS_DATA_DIR=/data \
  public.ecr.aws/cirrobio/spatial-data-studio:v1
```

Open `http://localhost:8080` and start a session on anything in the `data` folder you
mounted. With no memory limit set, the app sizes itself against your computer's total
memory. [`docker/README.md`](../../docker/README.md) has the compose file, the memory
limits and the full environment; [`DEVELOPMENT.md`](../../DEVELOPMENT.md#local-dev-environment)
has how to run from a clone instead.

Everything in [Analysis Workspaces](analysis-workspaces.md#find-your-way-around) works
the same here, including several people in one app at once. The app has no log-in of
its own: anyone who can reach its port can open and change your sessions, so expose the
port only to people you'd let do that.

## Work with an AI assistant

When the app runs on your own computer, an AI agent such as Claude can drive it. The
backend speaks the [Model Context Protocol](https://modelcontextprotocol.io/) at
`/api/mcp`, so the agent can drive the same studio you're looking at: load data, run
analyses and recipes, draw and *look at* plots and the tissue view (renders come back
with a world-coordinate grid and an exact pixel→coordinate mapping), restyle displays,
label regions of cells, subset, and save — every change appears in your browser live.
The agent joins the same per-session edit lock you do (it shows up as *Claude
(assistant)* on the padlock while it works, and hands control back when done), and
connects with built-in guidance covering the studio and spatial-omics analysis.

To connect Claude Code to the Docker install above:

```bash
claude mcp add --transport http spatial-data-studio http://127.0.0.1:8080/api/mcp
```

Use your own host and port if you changed them; a development server from a clone
listens on `8000`, and `claude` started inside the clone picks the server up by itself
through [`.mcp.json`](../../.mcp.json). Prefer `127.0.0.1` over `localhost`: the
development backend binds IPv4 only, and `localhost` can resolve to `::1` and reach some
other process using the port. The MCP endpoint is unauthenticated like the rest of the
app, so the same rule applies: expose the port only to people and processes you'd let
edit your sessions.
