import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { loginInput } from '@shared/schemas';
import {
  clearFailures,
  clearSessionCookie,
  clientIp,
  getSalt,
  guard,
  isSignedIn,
  makeToken,
  passwordMatches,
  recordFailure,
  setSessionCookie,
  tooManyFailures,
  WINDOW_MINUTES,
} from './auth';
import { admin } from './routes/admin';
import { connections } from './routes/connections';
import { explore } from './routes/explore';
import { files } from './routes/files';
import { pages } from './routes/pages';
import { ApiError, body, type AppEnv } from './routes/util';

export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', guard);

app.get('/health', (c) => c.json({ ok: true }));

app.get('/session', async (c) => {
  if (!(await isSignedIn(c)))
    return c.json({ error: 'unauthorized', message: 'Sign in first.' }, 401);
  return c.json({ ok: true });
});

app.post('/login', async (c) => {
  const db = c.env.DB;
  const ip = clientIp(c);
  if (await tooManyFailures(db, ip)) {
    c.header('Retry-After', String(WINDOW_MINUTES * 60));
    throw new ApiError(
      429,
      'rate_limited',
      `Too many wrong passwords. Try again in ${WINDOW_MINUTES} minutes.`,
    );
  }
  const { password } = await body(c, loginInput);
  if (!(await passwordMatches(password, c.env.APP_PASSWORD!))) {
    await recordFailure(db, ip);
    throw new ApiError(401, 'wrong_password', 'That password is not right.');
  }
  await clearFailures(db, ip);
  setSessionCookie(c, await makeToken(c.env.APP_PASSWORD!, await getSalt(db)));
  return c.json({ ok: true });
});

app.post('/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.route('/', pages);
app.route('/', files);
app.route('/', admin);
app.route('/', connections);
app.route('/', explore);

app.notFound((c) => c.json({ error: 'not_found', message: 'No such endpoint.' }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError)
    return c.json({ error: err.code, message: err.message, details: err.details }, err.status);
  if (err instanceof HTTPException)
    return c.json({ error: 'http', message: err.message }, err.status);
  const msg = err.message ?? '';
  if (/FOREIGN KEY constraint failed/i.test(msg))
    return c.json(
      { error: 'invalid', message: 'That refers to a page that no longer exists.' },
      400,
    );
  if (/no such table/i.test(msg)) {
    return c.json(
      {
        error: 'setup',
        message:
          'The database has not been set up yet. Run the D1 migrations (npm run db:migrate:remote).',
      },
      503,
    );
  }
  console.error(err);
  return c.json({ error: 'server', message: 'Something went wrong on the server.' }, 500);
});
