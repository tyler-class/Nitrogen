import { app } from './app.ts';
import type { Env } from './env.ts';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
