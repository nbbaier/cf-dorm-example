import { DurableObject } from "cloudflare:workers";
import { createClient, type DORMClient, type Records } from "dormroom";
import { Migratable } from "migratable-object";
import { Streamable } from "remote-sql-cursor";
import { Transfer } from "transferable-object";

export interface Env {
	DORM_NAMESPACE: DurableObjectNamespace<DORM>;
	DB_SECRET?: string;
}

interface Todo extends Records {
	id: string;
	text: string;
	completed: number;
	created_at: string;
	tenant_id: string;
}

@Migratable({
	migrations: {
		1: [`CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY)`],
		2: [
			`CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, text TEXT NOT NULL, completed INTEGER DEFAULT 0, created_at TEXT NOT NULL, tenant_id TEXT NOT NULL)`,
		],
	},
})

@Streamable()
export class DORM extends DurableObject {
	transfer = new Transfer(this);
	sql: SqlStorage;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.sql = state.storage.sql;
	}

	getDatabaseSize() {
		return this.sql.databaseSize;
	}
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const pathSegments = path
			.split("/")
			.filter((segment) => segment.length > 0);

		if (pathSegments.length === 0) {
			return new Response(
				JSON.stringify(
					{
						error:
							"No tenant specified. Please use /{tenantId} to specify a tenant.",
						example: "/default - for default tenant",
					},
					null,
					2,
				),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}

		try {
			const tenantId = pathSegments[0];

			const configs =
				tenantId === "aggregate"
					? [{ name: "aggregate" }]
					: [{ name: `tenant:${tenantId}` }, { name: "aggregate" }];

			const client: DORMClient<DORM> = createClient({
				doNamespace: env.DORM_NAMESPACE,
				ctx: ctx,
				configs,
			});

			if (tenantId !== "aggregate") {
				await client
					.exec("INSERT OR IGNORE INTO tenants (id) VALUES (?)", tenantId)
					.toArray();
			}

			if (path.startsWith(`/${tenantId}/api/db`)) {
				const middlewareResponse = await client.middleware(request, {
					prefix: `/${tenantId}/api/db`,
					secret: env.DB_SECRET || "my-secret-key",
				});

				if (middlewareResponse) {
					return middlewareResponse;
				}
			}

			const subPath =
				pathSegments.length > 1 ? `/${pathSegments.slice(1).join("/")}` : "/";

			if (tenantId === "aggregate") {
				return new Response("Not allowed", { status: 401 });
			}

			if (subPath === "/todos") {
				const { readable, writable } = new TransformStream();
				const writer = writable.getWriter();
				const encoder = new TextEncoder();

				ctx.waitUntil(
					(async () => {
						try {
							const cursor = client.exec<Todo>(
								"SELECT * FROM todos WHERE tenant_id = ? ORDER BY created_at DESC",
								tenantId,
							);

							await writer.write(encoder.encode("["));

							let first = true;
							for await (const todo of cursor) {
								if (!first) await writer.write(encoder.encode(","));
								await writer.write(encoder.encode(JSON.stringify(todo)));
								first = false;
							}

							await writer.write(encoder.encode("]"));
						} catch (error) {
							console.error("Streaming error:", error);
							const message =
								error instanceof Error ? error.message : String(error);
							await writer.write(encoder.encode(`{"error":"${message}"}`));
						} finally {
							await writer.close();
						}
					})(),
				);

				return new Response(readable, {
					headers: {
						"Content-Type": "application/json",
						"Transfer-Encoding": "chunked",
					},
				});
			}

			const newTodo = url.searchParams.get("new");
			const deleteTodo = url.searchParams.get("delete");
			const toggleTodo = url.searchParams.get("toggle");

			if (newTodo) {
				const id = crypto.randomUUID();
				await client
					.exec(
						"INSERT INTO todos (id, text, created_at, tenant_id) VALUES (?, ?, ?, ?)",
						id,
						newTodo,
						new Date().toISOString(),
						tenantId,
					)
					.toArray();

				return new Response(null, {
					status: 302,
					headers: {
						Location: `/${tenantId}${subPath}`,
					},
				});
			}

			if (deleteTodo) {
				await client
					.exec(
						"DELETE FROM todos WHERE id = ? AND tenant_id = ?",
						deleteTodo,
						tenantId,
					)
					.toArray();

				return new Response(null, {
					status: 302,
					headers: {
						Location: `/${tenantId}${subPath}`,
					},
				});
			}

			if (toggleTodo) {
				await client
					.exec(
						"UPDATE todos SET completed = CASE WHEN completed = 1 THEN 0 ELSE 1 END WHERE id = ? AND tenant_id = ?",
						toggleTodo,
						tenantId,
					)
					.toArray();

				return new Response(null, {
					status: 302,
					headers: {
						Location: `/${tenantId}${subPath}`,
					},
				});
			}

			const cursor = client.exec<Todo>(
				"SELECT * FROM todos WHERE tenant_id = ? ORDER BY created_at DESC",
				tenantId,
			);
			const todos = await cursor.toArray();

			const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>DORM TODO Demo - ${tenantId}</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                max-width: 800px;
                margin: 0 auto;
                padding: 20px;
                color: #333;
                background-color: #f9fafb;
              }
              h1 {
                color: #2563eb;
                border-bottom: 2px solid #e5e7eb;
                padding-bottom: 10px;
              }
              .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
              }
              .tenant-badge {
                background: #2563eb;
                color: white;
                padding: 8px 12px;
                border-radius: 6px;
                font-size: 0.9rem;
                font-weight: bold;
              }
              form {
                display: flex;
                margin-bottom: 20px;
                gap: 10px;
              }
              input[type="text"] {
                flex-grow: 1;
                padding: 12px;
                border: 1px solid #d1d5db;
                border-radius: 6px;
                font-size: 1rem;
              }
              button {
                background: #2563eb;
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 500;
                transition: background-color 0.2s;
              }
              button:hover {
                background: #1d4ed8;
              }
              .todo-list {
                list-style: none;
                padding: 0;
                background: white;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.05);
                overflow: hidden;
              }
              .todo-item {
                display: flex;
                align-items: center;
                padding: 16px;
                border-bottom: 1px solid #e5e7eb;
                transition: background-color 0.2s;
              }
              .todo-item:hover {
                background-color: #f3f4f6;
              }
              .todo-item:last-child {
                border-bottom: none;
              }
              .todo-status {
                margin-right: 12px;
                cursor: pointer;
                font-size: 1.2rem;
              }
              .todo-text {
                flex-grow: 1;
                font-size: 1.1rem;
                transition: color 0.2s;
              }
              .todo-text.completed {
                text-decoration: line-through;
                color: #9ca3af;
              }
              .todo-buttons {
                display: flex;
                gap: 8px;
              }
              .todo-toggle {
                background: #10b981;
              }
              .todo-toggle:hover {
                background: #059669;
              }
              .todo-delete {
                background: #ef4444;
                font-size: 0.9rem;
              }
              .todo-delete:hover {
                background: #dc2626;
              }
              .todo-count {
                margin: 20px 0;
                color: #6b7280;
                font-size: 0.9rem;
              }
              .tenant-form {
                margin-top: 30px;
                padding: 20px;
                border-top: 1px solid #e5e7eb;
                background: white;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.05);
              }
              .tenant-form h2 {
                margin-top: 0;
                color: #4b5563;
                font-size: 1.2rem;
              }
              .links {
                margin-top: 30px;
                padding: 20px;
                border-top: 1px solid #e5e7eb;
                background: white;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.05);
              }
              .links h2 {
                margin-top: 0;
                color: #4b5563;
                font-size: 1.2rem;
              }
              .links-container {
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
                margin-top: 12px;
              }
              .links a {
                display: inline-flex;
                align-items: center;
                padding: 8px 16px;
                background: #f3f4f6;
                color: #2563eb;
                text-decoration: none;
                border-radius: 6px;
                transition: background-color 0.2s;
              }
              .links a:hover {
                background: #e5e7eb;
              }
              .empty-state {
                text-align: center;
                padding: 40px 20px;
                color: #6b7280;
              }
              .empty-state p {
                margin: 10px 0 0;
              }
              .live-indicator {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                background: #ecfdf5;
                color: #059669;
                padding: 6px 12px;
                border-radius: 6px;
                font-size: 0.8rem;
                font-weight: 500;
                margin-bottom: 20px;
              }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>DORM TODO Demo</h1>
              <div class="tenant-badge">Tenant: ${tenantId}</div>
            </div>

            <div class="live-indicator">
              <span>●</span> Live Data | Last Updated: ${new Date().toLocaleTimeString()}
            </div>

            <form action="/${tenantId}" method="get">
              <input type="text" name="new" placeholder="Add a new todo..." required autofocus>
              <button type="submit">Add Todo</button>
            </form>

            <div class="todo-count">
              ${todos.length} item${todos.length !== 1 ? "s" : ""} total •
              ${todos.filter((t) => t.completed).length} completed •
              ${todos.filter((t) => !t.completed).length} active
            </div>

            <ul class="todo-list">
              ${
								todos.length > 0
									? todos
											.map(
												(todo) => `
                  <li class="todo-item">
                    <span class="todo-status">
                      ${todo.completed ? "✅" : "⬜️"}
                    </span>
                    <span class="todo-text ${
											todo.completed ? "completed" : ""
										}">${todo.text}</span>
                    <div class="todo-buttons">
                      <a href="/${tenantId}?toggle=${todo.id}">
                        <button class="todo-toggle">${
													todo.completed ? "Mark Active" : "Mark Complete"
												}</button>
                      </a>
                      <a href="/${tenantId}?delete=${todo.id}">
                        <button class="todo-delete">Delete</button>
                      </a>
                    </div>
                  </li>
                `,
											)
											.join("")
									: `<li class="empty-state">
                     <h3>No todos yet</h3>
                     <p>Add your first todo using the form above!</p>
                   </li>`
							}
            </ul>

            <div class="tenant-form">
              <h2>Switch to Another Tenant</h2>
              <form action="/" method="get" onsubmit="window.location.href='/' + this.tenant.value; return false;">
                <input type="text" name="tenant" placeholder="Enter tenant name..." value="${tenantId}" required>
                <button type="submit">Switch</button>
              </form>
            </div>

            <div class="links">
              <h2>Resources & Tools</h2>
              <div class="links-container">
                <a href="${`https://studio.outerbase.com/local/new-base/starbase?url=${encodeURIComponent(
									new URL(`/${tenantId}/api/db`, request.url).href,
								)}&type=internal&access-key=my-secret-key`}" target="_blank">Open in Outerbase</a>
                <a href="${`https://studio.outerbase.com/local/new-base/starbase?url=${encodeURIComponent(
									new URL(`/aggregate/api/db`, request.url).href,
								)}&type=internal&access-key=my-secret-key`}" target="_blank">Open aggregate in Outerbase</a>
              </div>
            </div>

            <script>
              // Auto-refresh every 30 seconds to show live data
              setTimeout(() => {
                window.location.reload();
              }, 30000);
            </script>
          </body>
          </html>
        `;

			return new Response(html, {
				headers: { "Content-Type": "text/html" },
			});
		} catch (error) {
			console.error("Error handling request:", error);
			const message = error instanceof Error ? error.message : String(error);
			return new Response(JSON.stringify({ error: message }, null, 2), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		}
	},
};
