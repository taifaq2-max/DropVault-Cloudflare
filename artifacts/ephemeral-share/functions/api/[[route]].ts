export const onRequest: PagesFunction<{ WORKER_URL: string }> = async (
  context,
) => {
  const workerUrl = context.env.WORKER_URL;
  if (!workerUrl) {
    return new Response(
      JSON.stringify({ error: "WORKER_URL is not configured" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const url = new URL(context.request.url);
  const target = new URL(url.pathname + url.search, workerUrl);

  const headers = new Headers(context.request.headers);
  headers.delete("host");

  const upstream = new Request(target.toString(), {
    method: context.request.method,
    headers,
    body: context.request.body,
    redirect: "follow",
    // @ts-expect-error: duplex is required for streaming request bodies
    duplex: "half",
  });

  return fetch(upstream);
};
