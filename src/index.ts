type Env = {
  DB: D1DatabaseWithReplicas
}

type D1DatabaseWithReplicas = {
  withSession(token: string): D1DatabaseSession
}

// For the code example, don't leak the fact that these types are _currently_ almost identical
type D1DatabaseSession = D1Database & {
  latestCommitToken: string
}

type Order = {
  orderName: string
  customer: string
  value: number
}

// CODE EXAMPLE HERE ON DOWN:

export default {
  async fetch(request: Request, env: Env) {
    // When we create a D1 Session, we can continue where we left off
    // from a previous Session if we have that Session's last commit
    // token.  This Worker will return the commit token back to the
    // browser, so that it can send it back on the next request to
    // continue the Session.
    //
    // If we don't have a commit token, make the first query in this
    // session an "unconditional" query that will use the state of the
    // database at whatever replica we land on.
    const token = request.headers.get('x-d1-token') ?? 'first-unconditional'
    const session = env.DB.withSession(token)

    // Use this session for all our Workers' routes.
    const response = await handleRequest(request, session)

    if (response.status === 200) {
      // Set the token so we can continue the session in another request.
      response.headers.set('x-d1-token', session.latestCommitToken)
    }
    return response
  }
}

async function handleRequest(request: Request, session: D1DatabaseSession) {
  const { pathname } = new URL(request.url)

  if (pathname === '/api/orders/list') {
    // This statement is a read query, so it will execute on any
    // replica that has a commit equal or later than `token`.
    const { results } = await session.prepare('SELECT * FROM Orders').all()

    return Response.json(results)
  } else if (pathname === '/api/orders/add') {
    const order = await request.json<Order>()

    // This statement is a write query, so D1 will send the query to
    // the primary, which always has the latest commit token.
    await session
      .prepare('INSERT INTO Orders VALUES (?, ?, ?)')
      .bind(order.orderName, order.customer, order.value)
      .run()

    // In order for the application to be correct, this SELECT
    // statement must see the results of the INSERT statement above.
    // The Session API keeps track of commit tokens for queries
    // within the session and will ensure that we won't execute this
    // query until whatever replica we're using has seen the results
    // of the INSERT.
    const { results } = await session
      .prepare('SELECT COUNT(*) FROM Orders')
      .all()

    return Response.json(results)
  }

  return new Response('Not found', { status: 404 })
}
