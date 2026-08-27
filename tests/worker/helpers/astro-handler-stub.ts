/**
 * Test-only stub. Product Worker imports `@astrojs/cloudflare/handler` for
 * prerendered pages; that module needs a Vite virtual config that does not
 * exist outside `astro build`. API / Durable Object tests never call this.
 */
export async function handle(
	_request: Request,
	_env: unknown,
	_ctx: unknown,
): Promise<Response> {
	return new Response('Not found', { status: 404 })
}
