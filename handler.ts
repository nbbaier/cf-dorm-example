import { createClient, type DORMClient } from "dormroom";
import { Hono } from "hono";
import { showRoutes } from "hono/dev";
import type { DORM, Env } from ".";

const app = new Hono<{ Bindings: Env }>();
const tenant = new Hono<{
	Variables: {
		client: DORMClient<DORM>;
		tenantId: string;
		ctx: ExecutionContext;
	};
	Bindings: Env;
}>().basePath("/:tenantId");

tenant.use(async (c, next) => {
	const url = new URL(c.req.url);
	const path = url.pathname;
	const pathSegments = path.split("/").filter((segment) => segment.length > 0);
	const subPath =
		pathSegments.length > 1 ? `/${pathSegments.slice(1).join("/")}` : "/";
	console.log(subPath);

	// const ctx = c.executionCtx;
	const tenantId = c.req.param("tenantId") as string;

	// c.set("ctx", ctx);

	const configs =
		tenantId === "aggregate"
			? [{ name: "aggregate" }]
			: [{ name: `tenant:${tenantId}` }, { name: "aggregate" }];

	// const client: DORMClient<DORM> = createClient({
	// 	doNamespace: c.env.DORM_NAMESPACE,
	// 	ctx: c.executionCtx,
	// 	configs,
	// });

	// c.set("client", client);
	// c.set("tenantId", tenantId);

	// if (tenantId !== "aggregate") {
	// 	await client
	// 		.exec("INSERT OR IGNORE INTO tenants (id) VALUES (?)", tenantId)
	// 		.toArray();
	// }

	console.log(`[${c.req.method}] ${c.req.url}`);
	await next();
});

tenant.get("/todos", (c) => {
	const tenantId = c.get("tenantId");
	return c.text(`GET /${tenantId}/todos`);
});

tenant.get("/", async (c) => {
	const tenantId = c.get("tenantId");

	if (tenantId === "aggregate") {
		return new Response("Not allowed", { status: 401 });
	}

	const newTodo = c.req.query("new");
	const deleteTodo = c.req.query("delete");
	const toggleTodo = c.req.query("toggle");

	if (newTodo) {
		const client = c.get("client");
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
				Location: `/${tenantId}`,
			},
		});
	}

	return c.text(`GET /${c.get("tenantId")}`);
});

app.get("/", (c) =>
	c.json(
		{
			error: "No tenant specified. Please use /{tenantId} to specify a tenant.",
			example: "/default - for default tenant",
		},
		400,
	),
);

app.route("/", tenant);

showRoutes(app);

export default app;
