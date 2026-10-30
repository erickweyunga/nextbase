import type {
  AuthCollection,
  AuthMethods,
  Collection,
  SignInMethod,
} from '@nextbasejs/client';
import {
  type DB,
  hash,
  type Row,
  type Tx,
  type TxOptions,
} from '@nextbasejs/dbx';
import {
  approveEmailChange,
  confirmAccountDeletion,
  confirmEmailChange,
  confirmEmailVerification,
  confirmPasswordReset,
  type FlowContext,
  requestAccountDeletion,
  requestEmailChange,
  requestEmailVerification,
  requestPasswordReset,
} from '../auth/flows.ts';
import { findByEmail } from '../auth/identity.ts';
import {
  type Account,
  accountFor,
  findLinked,
  listLinkedAccounts,
  unlinkAccount,
} from '../auth/linked-accounts.ts';
import {
  authWithPassword,
  checkAuthRule,
  EmailNotVerified,
} from '../auth/login.ts';
import type { Mailer } from '../auth/mail.ts';
import {
  type Challenge,
  IMPERSONATION,
  invalidMfa,
  type Mfa,
  MfaRequired,
  type Pending,
} from '../auth/mfa.ts';
import {
  checkData,
  checkParams,
  checkRedirect,
  checkScopes,
  type Identity,
  type OAuth2,
  OAuth2Error,
  setStateCookie,
} from '../auth/oauth2.ts';
import {
  authWithPhoneCode,
  confirmPasswordResetByPhone,
  confirmPhoneVerification,
  type PhoneContext,
  requestPasswordResetByPhone,
  requestPhoneCode,
  requestPhoneVerification,
} from '../auth/phone.ts';
import {
  forbidImpersonated,
  type Principal,
  recordIn,
  requireSuperuser,
} from '../auth/principal.ts';
import {
  bearerToken,
  checkSameOrigin,
  createSession,
  deleteOtherSessions,
  deleteSession,
  extendSession,
  IMPERSONATION_DURATION,
  impersonatorCookie,
  listSessions,
  mfaCookie,
  type OriginPolicy,
  type Session,
  sessionCookie,
  sessionIn,
  sessionModel,
  setImpersonatorCookie,
  setMfaCookie,
  setSessionCookie,
} from '../auth/sessions.ts';
import type { Sms } from '../auth/sms.ts';
import { completeSetup, hasSuperuser } from '../auth/superusers.ts';
import { countAttempt, mailKey } from '../auth/throttle.ts';
import { table } from '../db/system.ts';
import { Effects } from '../effects.ts';
import { ApiError } from '../errors.ts';
import {
  createUpload,
  fileResponse,
  fileToken,
  findFile,
  principalOfFileToken,
} from '../files/serve.ts';
import type { Storage } from '../files/storage.ts';
import type { Thumbs } from '../files/thumbs.ts';
import {
  readJsonObject,
  readOptionalJsonObject,
  readRecordBody,
} from '../http.ts';
import type { Logger } from '../logs/logger.ts';
import {
  deleteLogs,
  logModel,
  logStats,
  logsCollection,
} from '../logs/store.ts';
import { newId } from '../random.ts';
import type { Limited, RouteTag } from '../rate-limits.ts';
import type { Realtime } from '../realtime/stream.ts';
import type { Hooks } from '../records/hooks.ts';
import { serializeRecord } from '../records/serialize.ts';
import {
  type Apply,
  applyCreate,
  applyCreates,
  CreateFailed,
  createRuns,
  listRecords,
  outputRecord,
  type PlannedCreate,
  planDeleteRecord,
  planNewRecord,
  planUpdateRecord,
  type RecordsContext,
  viewRecord,
} from '../records/service.ts';
import { SCHEMA_VERSION_SQL, type Schema } from '../schema/cache.ts';
import {
  deleteCollection,
  newCollection,
  updateCollection,
} from '../schema/sync.ts';

interface Context {
  request: Request;
  params: string[];
  db: DB;
  schema: Schema;
  principal: Principal;
  /** Sent by server code through `client()`, not by a browser. */
  inProcess: boolean;
  /** 0 means no limit. */
  statementTimeout: number;
  /**
   * The route's transaction, if the route is marked `transaction`, or the
   * transaction of the on hook whose `e.nextbase` sent the request.
   */
  tx?: Tx;
  origins: OriginPolicy;
  mailer: Mailer;
  sms: Sms;
  oauth2: OAuth2;
  mfa: Mfa;
  rejectBreachedPasswords: boolean;
  effects: Effects;
  storage: Storage;
  thumbs: Thumbs;
  hooks: Hooks;
  /** Undefined when realtime is not enabled. */
  realtime: Realtime | undefined;
  /** For a request sent through `e.nextbase`: the on hooks that led to it. */
  hookChain: readonly string[];
  logger: Logger;
  /**
   * Records an error on the request's log entry when the response does not
   * have an error status, such as a failed OAuth2 sign-in's redirect.
   */
  noteError(error: string): void;
  /**
   * Counts requests against rate limits for the caller: this request when
   * none are given, as for a route marked `countsItself`, or the writes of
   * a batch. Throws the 429 of the first that is over. Does nothing for
   * in-process requests or when rate limits are off.
   */
  rateLimit(requests?: readonly Limited[]): Promise<void>;
}

export interface Route {
  method: string;
  /** Matched against the path below `basePath`; groups become `params`. */
  pattern: RegExp;
  /**
   * The route runs in a transaction opened before the handler, which also
   * reads the schema version. Use it only for routes that hold the
   * transaction briefly: a route that reads a request body would keep the
   * connection busy while the body arrives.
   */
  transaction?: true;
  /**
   * The route writes and locks only through `bounded`, so it can run in the
   * transaction of an on hook, for the hook's `e.nextbase`.
   */
  joinsTransaction?: true;
  /**
   * The response is a stream that stays open, so the request does not renew
   * the session: the renewed cookie could only be sent once it ends.
   */
  stream?: true;
  /**
   * What the route does, for rate limit labels such as `*:auth`. On routes
   * under `/collections/{collection}/` and `/files/{collection}/`, labels
   * naming that collection apply too.
   */
  tags?: readonly RouteTag[];
  /**
   * The handler counts the request itself, through `rateLimit()`, so it
   * can answer a refusal its own way.
   */
  countsItself?: true;
  handler(context: Context): Promise<Response>;
}

const segment = '([^/]+)';
const SUPERUSERS = '_superusers';

const records = new RegExp(`^/collections/${segment}/records$`);
const record = new RegExp(`^/collections/${segment}/records/${segment}$`);
const linkedAccounts = new RegExp(
  `^/collections/${segment}/records/${segment}/linked-accounts$`,
);
const ofRecord = (path: string): RegExp =>
  new RegExp(`^/collections/${segment}/records/${segment}/${path}$`);

export const ROUTES: readonly Route[] = [
  {
    method: 'GET',
    pattern: records,
    tags: ['list'],
    transaction: true,
    joinsTransaction: true,
    async handler(context) {
      const { url } = parse(context);
      const collection = context.schema.get(context.params[0] as string);
      return Response.json(
        await bounded(context, (db) =>
          listRecords(
            recordsContext(context, {}, { db }),
            collection,
            url.searchParams,
          ),
        ),
      );
    },
  },
  {
    method: 'POST',
    pattern: records,
    tags: ['create'],
    joinsTransaction: true,
    async handler(context) {
      const body = await readRecordBody(context.request);
      return replyOf(
        await writeRecord(context, {
          method: 'POST',
          collection: context.params[0] as string,
          body,
          query: parse(context).url.searchParams,
        }),
      );
    },
  },
  {
    method: 'GET',
    pattern: record,
    tags: ['view'],
    transaction: true,
    joinsTransaction: true,
    async handler(context) {
      const { url } = parse(context);
      const [collection, id] = context.params as [string, string];
      const target = context.schema.get(collection);
      return Response.json(
        await bounded(context, (db) =>
          viewRecord(
            recordsContext(context, {}, { db }),
            target,
            id,
            url.searchParams,
          ),
        ),
      );
    },
  },
  {
    method: 'PATCH',
    pattern: record,
    tags: ['update'],
    joinsTransaction: true,
    async handler(context) {
      const [collection, id] = context.params as [string, string];
      const body = await readRecordBody(context.request);
      return replyOf(
        await writeRecord(context, {
          method: 'PATCH',
          collection,
          id,
          body,
          query: parse(context).url.searchParams,
        }),
      );
    },
  },
  {
    method: 'DELETE',
    pattern: record,
    tags: ['delete'],
    joinsTransaction: true,
    async handler(context) {
      const [collection, id] = context.params as [string, string];
      // Optional: deleting one's own account takes `password` or `mfaCode`.
      const body = await readOptionalJsonObject(context.request);
      return replyOf(
        await writeRecord(context, {
          method: 'DELETE',
          collection,
          id,
          body,
          query: parse(context).url.searchParams,
        }),
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/batch$/,
    tags: ['batch'],
    joinsTransaction: true,
    async handler(context) {
      const writes = parseBatch(await readJsonObject(context.request));
      // Each write counts as it would sent on its own, before any runs.
      await context.rateLimit(
        writes.map((write) => ({
          method: write.method,
          route: write.path,
          tags: [WRITE_TAGS[write.method]],
          collection: context.schema.find(write.collection),
        })),
      );
      // Writes are planned before the transaction starts, then all run in it:
      // all or nothing. Planning stops at the first write that fails. The
      // writes before it still run, so the batch reports the first failing
      // write in order, as when each is checked and run in turn.
      const planned: PlannedWrite[] = [];
      let failed: unknown;
      const written = new Set<string>();
      for (const [i, write] of writes.entries()) {
        try {
          planned.push(
            await inBatch(i, () =>
              planRecordWrite(context, write, new Set(written)),
            ),
          );
        } catch (error) {
          failed = error;
          break;
        }
        // A delete can cascade into any collection that points at it.
        const names =
          write.method === 'DELETE'
            ? context.schema.collections.map((c) => c.name)
            : [context.schema.get(write.collection).name];
        for (const name of names) written.add(name);
      }
      if (planned.length === 0) throw failed;
      const results = await bounded(context, async (tx) => {
        const replies: Reply[] = [];
        while (replies.length < planned.length) {
          const i = replies.length;
          const write = planned[i] as PlannedWrite;
          if ('apply' in write) {
            replies.push(await inBatch(i, () => write.apply(tx)));
            continue;
          }
          // Consecutive creates are done together, a run at a time.
          const creates: PlannedCreate[] = [];
          for (const next of planned.slice(i)) {
            if (!('create' in next)) break;
            creates.push(next.create);
          }
          for (const run of createRuns(creates)) {
            const start = replies.length;
            try {
              const records = await applyCreates(tx, run);
              replies.push(...records.map(replyWith));
            } catch (error) {
              if (!(error instanceof CreateFailed)) throw error;
              throw batchError(start + error.index, error.error);
            }
          }
        }
        if (failed !== undefined) throw failed;
        return replies;
      });
      return Response.json(results);
    },
  },
  {
    method: 'POST',
    pattern: /^\/realtime$/,
    tags: ['realtime'],
    stream: true,
    async handler(context) {
      if (!context.realtime)
        throw new ApiError(404, 'Realtime is not enabled.');
      return context.realtime.open(context);
    },
  },
  {
    method: 'GET',
    pattern: /^\/setup$/,
    async handler({ db }) {
      return Response.json({ required: !(await hasSuperuser(db)) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/setup$/,
    async handler({ request, db, schema, principal }) {
      const record = await completeSetup(
        db,
        schema,
        await readJsonObject(request),
      );
      return Response.json(
        serializeRecord(schema.get('_superusers'), record, {
          ...principal,
          superuser: true,
        }),
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/collections$/,
    async handler({ schema, principal }) {
      requireSuperuser(principal);
      const items = schema.collections;
      return Response.json({
        page: 1,
        perPage: items.length,
        totalItems: items.length,
        totalPages: 1,
        items,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/collections$/,
    async handler({ request, db, principal }) {
      requireSuperuser(principal);
      const input = await readJsonObject(request);
      return Response.json(await schemaChange(() => newCollection(db, input)));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/collections/${segment}$`),
    async handler({ params, schema, principal }) {
      requireSuperuser(principal);
      return Response.json(schema.get(params[0] as string));
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/collections/${segment}$`),
    async handler({ request, params, db, principal, effects }) {
      requireSuperuser(principal);
      const input = await readJsonObject(request);
      return Response.json(
        await schemaChange(() =>
          updateCollection(
            db,
            params[0] as string,
            input,
            effects.obsoleteFiles,
          ),
        ),
      );
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/collections/${segment}$`),
    async handler({ params, db, schema, principal, storage, logger }) {
      requireSuperuser(principal);
      const { id } = schema.get(params[0] as string);
      await schemaChange(() => deleteCollection(db, params[0] as string));
      // A failure only leaves unused files behind.
      await storage.deletePrefix(`${id}/`).catch((error: unknown) => {
        logger.failure(
          'storage',
          "deleting a collection's files failed",
          error,
        );
      });
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/collections/${segment}/upload-url$`),
    tags: ['file'],
    async handler({ request, params, db, schema, principal, storage, logger }) {
      const collection = schema.get(params[0] as string);
      const input = await readJsonObject(request);
      return Response.json(
        await createUpload(db, storage, collection, principal, input, logger),
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/files\/token$/,
    tags: ['file'],
    async handler({ principal }) {
      if (!principal.record || !principal.collection) {
        throw new ApiError(401, 'Sign in to get a file token.');
      }
      // A file token from an impersonation session ends with it.
      const session =
        principal.impersonatedBy !== undefined ? principal.session : undefined;
      return Response.json({
        token: await fileToken(principal.collection, principal.record, session),
      });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/files/${segment}/${segment}/${segment}$`),
    tags: ['file'],
    async handler(context) {
      const { request, params, db, schema, storage, thumbs } = context;
      const { collection, field, key } = await findFile(db, schema, params);
      const query = new URL(request.url).searchParams;
      if (field.protected) {
        // The view rule decides, for the session's caller or the file token's.
        const token = query.get('token');
        const principal = token
          ? ((await principalOfFileToken(db, schema, token)) ?? {
              superuser: false,
            })
          : context.principal;
        await viewRecord(
          recordsContext({ ...context, principal }, {}),
          collection,
          params[1] as string,
          new URLSearchParams(),
        );
      }
      const download = query.has('download') && query.get('download') !== '0';
      const thumb = query.get('thumb');
      const served = thumb ? await thumbs.keyOf(field, key, thumb) : key;
      if (served === undefined) {
        // To the original's own URL, so caches keep it only under that.
        const original = new URL(request.url);
        original.searchParams.delete('thumb');
        return new Response(null, {
          status: 302,
          headers: {
            location: `${original.pathname}${original.search}`,
            'cache-control': 'no-store',
          },
        });
      }
      return fileResponse(storage, served, request, {
        download,
        protectedFile: field.protected,
      });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/collections/${segment}/auth-with-password$`),
    tags: ['auth'],
    async handler(context) {
      const { request, params, db, schema, inProcess, origins } = context;
      const collection = authCollection(schema, params[0] as string);
      const input = await readJsonObject(request);
      const { identity, password, cookie } = input;
      if (typeof identity !== 'string' || typeof password !== 'string') {
        throw new ApiError(400, 'Failed to authenticate.', {
          ...(typeof identity !== 'string' && {
            identity: { code: 'validation_required', message: 'Required.' },
          }),
          ...(typeof password !== 'string' && {
            password: { code: 'validation_required', message: 'Required.' },
          }),
        });
      }
      // Another site must not sign the browser in to an account of its choosing.
      if (cookie === true && !inProcess) checkSameOrigin(request, origins);
      // A second step names its sign-in before the password is checked.
      const named =
        input.mfaId === undefined
          ? undefined
          : await bodyStep(context, collection, input.mfaId, 'password');
      const record = await authWithPassword(
        db,
        schema,
        collection,
        identity,
        password,
      ).catch(async (error: unknown) => {
        // The password was right: the link goes out again if asked for.
        if (
          error instanceof EmailNotVerified &&
          collection.emailVerification.sendOnSignIn
        ) {
          await sendVerification(context, collection, error.email);
        }
        throw error;
      });
      const step =
        named ?? (await cookieStep(context, collection, record, 'password'));
      if (step) {
        if (step.pending.record.id !== record.id) throw invalidMfa();
        return finishStep(context, step, 'password', cookie === true);
      }
      return completeSignIn(
        context,
        collection,
        record,
        'password',
        cookie === true,
      );
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/collections/${segment}/auth-methods$`),
    async handler({ params, schema, oauth2 }) {
      const collection = authCollection(schema, params[0] as string);
      const providers = collection.id === SUPERUSERS ? [] : oauth2.list();
      return Response.json({
        password: {
          enabled: collection.authRule !== null,
          identityFields: collection.identityFields,
        },
        oauth2: {
          enabled: collection.authRule !== null && providers.length > 0,
          providers,
        },
        phone: {
          enabled:
            collection.authRule !== null &&
            collection.phoneSignIn &&
            collection.id !== SUPERUSERS,
        },
        mfa: {
          enabled: collection.authRule !== null && collection.mfa.enabled,
          duration: collection.mfa.duration,
        },
      } satisfies AuthMethods);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/collections/${segment}/request-phone-code$`),
    tags: ['auth'],
    async handler(context) {
      const { request, params, db, schema, principal, mfa } = context;
      const collection = authCollection(schema, params[0] as string);
      forbidImpersonated(principal, 'change sign-in details');
      const input = await readJsonObject(request);
      // Without a phone, a code for the second step of a sign-in, texted
      // to the record's verified phone.
      if (
        input.mfaId !== undefined ||
        (input.phone === undefined && mfaCookie(request) !== undefined)
      ) {
        const step = await requiredStep(context, collection, input);
        await mfa.sendPhoneCode(db, step.pending);
      } else {
        await requestPhoneCode(phoneContext(context), collection, input.phone);
      }
      return new Response(null, { status: 204 });
    },
  },
  ...phoneFlow('request-password-reset-by-phone', (ctx, collection, input) =>
    requestPasswordResetByPhone(ctx, collection, input.phone),
  ),
  ...phoneFlow('confirm-password-reset-by-phone', (ctx, collection, input) =>
    confirmPasswordResetByPhone(ctx, collection, input),
  ),
  ...phoneFlow(
    'request-phone-verification',
    (ctx, collection, input, principal) =>
      requestPhoneVerification(ctx, collection, principal, input),
  ),
  ...phoneFlow(
    'confirm-phone-verification',
    (ctx, collection, input, principal) =>
      confirmPhoneVerification(ctx, collection, principal, input),
  ),
  {
    method: 'POST',
    pattern: new RegExp(`^/collections/${segment}/auth-with-phone-code$`),
    tags: ['auth'],
    async handler(context) {
      const { request, params, db, schema, inProcess, origins } = context;
      const collection = authCollection(schema, params[0] as string);
      const input = await readJsonObject(request);
      const { phone, code, cookie } = input;
      // Another site must not sign the browser in to an account of its choosing.
      if (cookie === true && !inProcess) checkSameOrigin(request, origins);
      // Without a phone, the second step of a sign-in, with a code texted
      // to the record's verified phone.
      if (
        input.mfaId !== undefined ||
        (phone === undefined && mfaCookie(request) !== undefined)
      ) {
        const step = await requiredStep(context, collection, input);
        await context.mfa.verifyCode(db, step.pending, 'phoneCode', code);
        return finishStep(context, step, 'phoneCode', cookie === true);
      }
      const record = await authWithPhoneCode(
        phoneContext(context),
        collection,
        phone,
        code,
      );
      await checkAuthRule(db, schema, collection, record.id as string);
      return completeSignIn(
        context,
        collection,
        record,
        'phoneCode',
        cookie === true,
      );
    },
  },
  ...secondStep('auth-with-totp', 'totp'),
  ...secondStep('auth-with-recovery-code', 'recoveryCode'),
  ...secondStep('auth-with-email-code', 'emailCode'),
  {
    method: 'POST',
    pattern: new RegExp(`^/collections/${segment}/request-email-code$`),
    tags: ['auth'],
    async handler(context) {
      const { request, params, db, schema, principal, mfa } = context;
      const collection = authCollection(schema, params[0] as string);
      forbidImpersonated(principal, 'change sign-in details');
      const input = await readJsonObject(request);
      const step = await requiredStep(context, collection, input);
      await mfa.sendEmailCode(db, step.pending);
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(
      `^/collections/${segment}/auth-with-oauth2/${segment}$`,
    ),
    tags: ['auth'],
    countsItself: true,
    async handler(context) {
      const { request, params, db, schema, oauth2 } = context;
      const query = new URL(request.url).searchParams;
      // Counted first, so requests that fail below count too. The browser
      // is navigating, so a refusal goes back to the app as its other
      // sign-in errors do, not as JSON; only to a redirect that is valid,
      // and only when OAuth2 is set up, so there is an app to return to.
      try {
        await context.rateLimit();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429) throw error;
        let back: string;
        try {
          oauth2.provider(params[1] as string);
          back =
            checkRedirect(query.get('errorRedirect'), 'errorRedirect') ||
            checkRedirect(query.get('redirect'));
        } catch {
          throw error;
        }
        context.noteError('too_many_requests');
        return new Response(null, {
          status: 302,
          headers: {
            ...error.headers,
            location: oauth2.returnUrl(back, 'too_many_requests'),
          },
        });
      }
      const collection = authCollection(schema, params[0] as string);
      if (collection.id === SUPERUSERS) {
        throw new ApiError(400, 'Superusers sign in with their password.');
      }
      const provider = oauth2.provider(params[1] as string);
      const redirect = checkRedirect(query.get('redirect'));
      const errorRedirect =
        checkRedirect(query.get('errorRedirect'), 'errorRedirect') || redirect;
      // Linking needs the password, which a link in the URL cannot carry.
      if (query.has('link')) {
        throw new ApiError(
          400,
          `Start a link with POST /collections/${params[0] as string}/link-oauth2/${provider.name}.`,
        );
      }
      // The second step of a sign-in, by a provider linked to its record.
      let mfaIdHash: string | null = null;
      if (query.has('mfaId')) {
        const pending = await context.mfa.pending(
          db,
          collection,
          query.get('mfaId'),
        );
        await context.mfa.allow(db, pending, 'oauth2');
        mfaIdHash = pending.idHash;
      }
      const { location, state } = await oauth2.start(db, {
        collection,
        provider,
        redirect,
        errorRedirect,
        linkRecordId: null,
        mfaIdHash,
        ...extras(query.get('params'), query.get('data')),
        scopes: query.has('scopes')
          ? checkScopes((query.get('scopes') ?? '').split(' ').filter(Boolean))
          : [],
      });
      return new Response(null, {
        status: 302,
        headers: [
          ['location', location],
          ['set-cookie', setStateCookie(request, state)],
        ],
      });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/collections/${segment}/auth-with-id-token/${segment}$`,
    ),
    tags: ['auth'],
    async handler(context) {
      const { request, params, db, schema, inProcess, origins, oauth2 } =
        context;
      const collection = authCollection(schema, params[0] as string);
      if (collection.id === SUPERUSERS) {
        throw new ApiError(400, 'Superusers sign in with their password.');
      }
      const provider = oauth2.provider(params[1] as string);
      const input = await readJsonObject(request);
      const cookie = input.cookie === true;
      if (cookie && !inProcess) checkSameOrigin(request, origins);
      const data = input.data === undefined ? null : checkData(input.data);
      // A second step names its sign-in before the token is checked.
      const step =
        input.mfaId === undefined
          ? undefined
          : await bodyStep(context, collection, input.mfaId, 'oauth2');
      const identity = await oauth2.verifyIdToken(
        db,
        provider,
        input.token,
        input.nonce,
      );
      if (step) {
        const linked = await findLinked(
          db,
          collection,
          provider.name,
          identity.id,
        );
        if (linked?.id !== step.pending.record.id) {
          throw new ApiError(
            400,
            'This provider account is not linked to the account signing in.',
            {
              token: {
                code: 'validation_mfa_method',
                message: 'Not linked to this account.',
              },
            },
          );
        }
        return finishStep(context, step, 'oauth2', cookie);
      }
      let account: Account;
      try {
        account = await accountFor(
          { db, schema, effects: context.effects, hooks: context.hooks },
          collection,
          {
            name: provider.name,
            disableSignUp: provider.disableSignUp,
            mapProfile: provider.mapProfile,
            data,
          },
          identity,
          null,
        );
      } catch (error) {
        // The codes the browser sign-in returns in `?error=`.
        if (error instanceof OAuth2Error) {
          throw new ApiError(400, error.message, {
            token: { code: error.code, message: error.message },
          });
        }
        throw error;
      }
      if (account.linkedTo !== undefined) {
        context.mailer.send('oauth2Linked', collection.name, account.linkedTo, {
          provider: provider.displayName,
        });
      }
      await checkAuthRule(db, schema, collection, account.record.id as string);
      return completeSignIn(
        context,
        collection,
        account.record,
        'oauth2',
        cookie,
      );
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/collections/${segment}/link-oauth2/${segment}$`),
    tags: ['auth'],
    async handler(context) {
      const { request, params, db, schema, principal, origins, oauth2, mfa } =
        context;
      const collection = authCollection(schema, params[0] as string);
      if (collection.id === SUPERUSERS) {
        throw new ApiError(400, 'Superusers sign in with their password.');
      }
      const provider = oauth2.provider(params[1] as string);
      // Linking adds a way into the account, so only this site may start
      // it, and only with the password: a stolen session cannot.
      checkSameOrigin(request, origins);
      forbidImpersonated(principal, 'link a provider');
      const record = recordIn(principal, collection, 'link a provider');
      const input = await readJsonObject(request);
      const redirect = checkRedirect(
        typeof input.redirect === 'string' ? input.redirect : null,
      );
      const errorRedirect =
        checkRedirect(
          typeof input.errorRedirect === 'string' ? input.errorRedirect : null,
          'errorRedirect',
        ) || redirect;
      const extra = extras(
        input.params === undefined ? null : JSON.stringify(input.params),
        input.data === undefined ? null : JSON.stringify(input.data),
      );
      await mfa.reauthenticate(db, collection, record, input);
      const { location, state } = await oauth2.start(db, {
        collection,
        provider,
        redirect,
        errorRedirect,
        linkRecordId: record.id as string,
        mfaIdHash: null,
        ...extra,
        scopes: input.scopes === undefined ? [] : checkScopes(input.scopes),
      });
      const response = Response.json({ url: location });
      response.headers.append('set-cookie', setStateCookie(request, state));
      return response;
    },
  },
  {
    method: 'GET',
    // Untagged, so sign-in limits leave it be: it is bound to the state
    // cookie and a single-use code, and a refusal would lose the sign-in.
    pattern: new RegExp(`^/callback/${segment}$`),
    async handler(context) {
      const { request, params, db, schema, principal, mailer, oauth2, mfa } =
        context;
      // Unknown, or OAuth2 is not set up: there is no app URL to return to.
      oauth2.provider(params[0] as string);
      let redirect = '';
      let errorRedirect = '';
      const back = (error?: string): Response => {
        const to = error === undefined ? redirect : errorRedirect;
        const response = new Response(null, {
          status: 302,
          headers: [['location', oauth2.returnUrl(to, error)]],
        });
        response.headers.append('set-cookie', setStateCookie(request));
        return response;
      };
      try {
        const state = await oauth2.consumeState(db, request);
        ({ redirect, errorRedirect } = state);
        // Otherwise a malicious provider could pass off its response as
        // another provider's.
        if (params[0] !== state.provider) {
          throw new OAuth2Error(
            'oauth2_failed',
            'The sign-in returned from another provider.',
          );
        }
        const provider = oauth2.provider(state.provider);
        const collection = authCollection(schema, state.collectionId);
        // A link is for the record that started it, still signed in here,
        // and never for a superuser acting as it.
        if (
          state.linkRecordId !== null &&
          (principal.record?.id !== state.linkRecordId ||
            principal.impersonatedBy !== undefined)
        ) {
          throw new OAuth2Error(
            'oauth2_failed',
            'Sign in again to link this provider.',
          );
        }
        const identity = await oauth2.identify(provider, state, request);
        if (state.mfaIdHash !== null) {
          return await oauth2Step(context, collection, state.mfaIdHash, {
            provider: provider.name,
            identity,
            back,
          });
        }
        const { record, linkedTo } = await accountFor(
          { db, schema, effects: context.effects, hooks: context.hooks },
          collection,
          {
            name: provider.name,
            disableSignUp: provider.disableSignUp,
            mapProfile: provider.mapProfile,
            data: state.data,
          },
          identity,
          state.linkRecordId,
        );
        if (identity.tokens) {
          await oauth2.saveTokens(
            db,
            collection.id,
            record.id as string,
            provider.name,
            identity.tokens,
          );
        }
        if (linkedTo !== undefined) {
          mailer.send('oauth2Linked', collection.name, linkedTo, {
            provider: provider.displayName,
          });
        }
        if (state.linkRecordId !== null) return back();
        let challenge: Challenge | undefined;
        try {
          await checkAuthRule(db, schema, collection, record.id as string);
          challenge = await mfa.challenge(
            db,
            schema,
            collection,
            record,
            'oauth2',
          );
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            throw new OAuth2Error('sign_in_forbidden', error.message);
          }
          throw error;
        }
        // The second step is taken on the app's page. Its id stays in an
        // HttpOnly cookie, out of the URL; GET /collections/{c}/mfa reads
        // the methods it can take.
        if (challenge) {
          const response = new Response(null, {
            status: 302,
            headers: [
              [
                'location',
                oauth2.returnUrl(redirect, undefined, { mfa: 'required' }),
              ],
            ],
          });
          response.headers.append('set-cookie', setStateCookie(request));
          response.headers.append(
            'set-cookie',
            setMfaCookie(request, {
              mfaId: challenge.mfaId,
              maxAge: challenge.duration,
            }),
          );
          return response;
        }
        // As on any cookie sign-in, the session in the cookie is replaced.
        if (principal.viaCookie && principal.session) {
          await deleteSession(db, principal.session);
        }
        const { token, session } = await createSession(
          db,
          collection,
          record,
          request.headers.get('user-agent') ?? '',
          { methods: ['oauth2'] },
        );
        const response = back();
        response.headers.append(
          'set-cookie',
          setSessionCookie(request, { token, expires: session.expires }),
        );
        return response;
      } catch (error) {
        if (error instanceof OAuth2Error) {
          context.noteError(error.code);
          return back(error.code);
        }
        context.logger.failure('oauth2', 'an OAuth2 sign-in failed', error);
        context.noteError('oauth2_failed');
        return back('oauth2_failed');
      }
    },
  },
  {
    method: 'GET',
    pattern: linkedAccounts,
    tags: ['list'],
    async handler({ params, db, schema, principal }) {
      const { collection, id } = ownRecord(schema, principal, params);
      return Response.json({
        items: await listLinkedAccounts(db, collection.id, id),
      });
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(
      `^/collections/${segment}/records/${segment}/linked-accounts/${segment}$`,
    ),
    tags: ['delete'],
    async handler({
      request,
      params,
      db,
      schema,
      principal,
      mailer,
      oauth2,
      mfa,
    }) {
      const { collection, id } = ownRecord(schema, principal, params);
      forbidImpersonated(principal, 'unlink a provider');
      // Its owner needs the password, so a stolen session cannot remove a
      // way the owner signs in.
      if (!principal.superuser && principal.record) {
        await mfa.reauthenticate(
          db,
          collection,
          principal.record,
          await readJsonObject(request),
        );
      }
      const unlinked = await unlinkAccount(
        db,
        collection.id,
        id,
        params[2] as string,
      );
      if (!unlinked) throw new ApiError(404, 'The provider is not linked.');
      const [owner] = await db
        .select('email')
        .from(table(collection.name))
        .where(hash({ id }))
        .all();
      if (owner) {
        mailer.send('oauth2Unlinked', collection.name, owner.email as string, {
          provider: oauth2.displayName(params[2] as string),
        });
      }
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(
      `^/collections/${segment}/records/${segment}/linked-accounts/${segment}/token$`,
    ),
    tags: ['view'],
    async handler({ request, params, db, schema, principal, oauth2 }) {
      const { collection, id } = ownRecord(schema, principal, params);
      // A superuser acting as the account must not walk off with its
      // access to the provider.
      forbidImpersonated(principal, 'read provider tokens');
      return Response.json(
        await oauth2.accessToken(db, collection, id, params[2] as string, {
          refresh: new URL(request.url).searchParams.get('refresh') === 'true',
        }),
      );
    },
  },
  {
    method: 'DELETE',
    pattern: ofRecord('mfa'),
    tags: ['auth'],
    async handler({ params, db, schema, principal, mfa }) {
      // For an owner who lost their app. Never their own: that takes a code.
      forbidImpersonated(principal, 'manage multi-factor sign-in');
      requireSuperuser(principal);
      const collection = authCollection(schema, params[0] as string);
      const id = params[1] as string;
      if (
        principal.collection?.id === collection.id &&
        principal.record?.id === id
      ) {
        throw new ApiError(
          400,
          'Remove your own authenticator app with a code from it.',
        );
      }
      const [record] = await db
        .select()
        .from(table(collection.name))
        .where(hash({ id }))
        .all();
      if (!record) throw new ApiError(404, 'Record not found.');
      await mfa.clear(db, collection, record);
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/collections/${segment}/mfa$`),
    tags: ['auth'],
    async handler({ request, params, db, schema, mfa }) {
      // The cookie is HttpOnly, so the page asks which second steps its
      // OAuth2 sign-in can take. A read, which other sites cannot see.
      const collection = authCollection(schema, params[0] as string);
      const cookie = mfaCookie(request);
      if (cookie === undefined) throw invalidMfa();
      const pending = await mfa.pending(db, collection, cookie);
      return Response.json({ methods: await mfa.methodsOf(db, pending) });
    },
  },
  {
    method: 'GET',
    pattern: ofRecord('mfa'),
    tags: ['auth'],
    async handler({ params, db, schema, principal, mfa }) {
      const { collection, record } = ownMfa(schema, principal, params);
      return Response.json(
        await mfa.status(db, collection, record.id as string),
      );
    },
  },
  {
    method: 'POST',
    pattern: ofRecord('totp'),
    tags: ['auth'],
    async handler({ request, params, db, schema, principal, mfa }) {
      const { collection, record } = ownMfa(schema, principal, params);
      const { password } = await readJsonObject(request);
      return Response.json(
        await mfa.startTotp(db, collection, record, password),
      );
    },
  },
  {
    method: 'POST',
    pattern: ofRecord('totp/confirm'),
    tags: ['auth'],
    async handler({ request, params, db, schema, principal, mfa }) {
      const { collection, record, session } = ownMfa(schema, principal, params);
      const { code } = await readJsonObject(request);
      return Response.json({
        recoveryCodes: await mfa.confirmTotp(
          db,
          collection,
          record,
          session,
          code,
        ),
      });
    },
  },
  {
    method: 'DELETE',
    pattern: ofRecord('totp'),
    tags: ['auth'],
    async handler({ request, params, db, schema, principal, mfa }) {
      const { collection, record } = ownMfa(schema, principal, params);
      const { mfaCode } = await readJsonObject(request);
      await mfa.removeTotp(db, collection, record, mfaCode);
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'POST',
    pattern: ofRecord('recovery-codes'),
    tags: ['auth'],
    async handler({ request, params, db, schema, principal, mfa }) {
      const { collection, record } = ownMfa(schema, principal, params);
      const { mfaCode } = await readJsonObject(request);
      return Response.json({
        recoveryCodes: await mfa.regenerateRecoveryCodes(
          db,
          collection,
          record,
          mfaCode,
        ),
      });
    },
  },
  ...flow('request-email-verification', (ctx, collection, input) =>
    requestEmailVerification(ctx, collection, input.email),
  ),
  ...flow('confirm-email-verification', (ctx, collection, input) =>
    confirmEmailVerification(ctx, collection, input.token),
  ),
  ...flow('request-password-reset', (ctx, collection, input) =>
    requestPasswordReset(ctx, collection, input.email),
  ),
  ...flow('confirm-password-reset', (ctx, collection, input) =>
    confirmPasswordReset(ctx, collection, input),
  ),
  ...flow('request-email-change', (ctx, collection, input, principal) =>
    requestEmailChange(ctx, collection, principal, input),
  ),
  ...flow('approve-email-change', (ctx, collection, input) =>
    approveEmailChange(ctx, collection, input),
  ),
  ...flow('confirm-email-change', (ctx, collection, input) =>
    confirmEmailChange(ctx, collection, input),
  ),
  ...flow('request-account-deletion', (ctx, collection, _input, principal) =>
    requestAccountDeletion(ctx, collection, principal),
  ),
  ...flow('confirm-account-deletion', (ctx, collection, input) =>
    confirmAccountDeletion(ctx, collection, input),
  ),
  {
    method: 'POST',
    pattern: new RegExp(`^/collections/${segment}/sign-up$`),
    tags: ['auth'],
    async handler(context) {
      const { request, params, db, schema, inProcess, origins } = context;
      const collection = authCollection(schema, params[0] as string);
      const { cookie, ...input } = await readRecordBody(request);
      if (cookie === true && !inProcess) checkSameOrigin(request, origins);
      // Chosen here so the record can be signed in even if the caller cannot view it.
      const id =
        typeof input.id === 'string' && input.id !== '' ? input.id : newId();
      const write = (body: Record<string, unknown>): RecordWrite => ({
        method: 'POST',
        collection: collection.id,
        body: { ...body, id },
        query: new URLSearchParams(),
      });
      // A new account could not sign in before verifying its email either,
      // so a registered one answers the same, doing the same work, and its
      // owner is told instead. The same sign-up with an unused email, rolled
      // back, answers what another field would; Postgres names only the
      // first value already taken.
      // An empty email, as a phone sign-up has, is no one's.
      const hidden =
        collection.emailVerification.required &&
        typeof input.email === 'string' &&
        input.email.trim() !== ''
          ? input.email.trim()
          : undefined;
      let taken =
        hidden !== undefined &&
        (await findByEmail(db, collection, hidden)) !== undefined;
      try {
        if (taken && hidden !== undefined) {
          await rehearse(
            context,
            write({ ...input, email: unusedEmail(hidden) }),
          );
        } else {
          await writeRecord(context, write(input));
        }
      } catch (error) {
        // Registered meanwhile, by a sign-up at the same moment.
        if (hidden === undefined || taken || !takenEmail(error)) throw error;
        taken = true;
      }
      if (taken && hidden !== undefined) {
        await tellOwnerOfSignUp(context, collection, hidden);
        return new Response(null, { status: 202 });
      }
      const [record] = (await db
        .select()
        .from(table(collection.name))
        .where(hash({ id }))
        .all()) as Row[];
      if (
        collection.emailVerification.sendOnSignUp &&
        record?.email &&
        record.emailVerified !== true
      ) {
        await sendVerification(context, collection, record.email as string);
      }
      try {
        await checkAuthRule(db, schema, collection, id);
      } catch (error) {
        // Created but not allowed to sign in yet (e.g. unverified email).
        if (error instanceof ApiError && error.status === 403) {
          return new Response(null, { status: 202 });
        }
        throw error;
      }
      let challenge: Challenge | undefined;
      try {
        challenge = await context.mfa.challenge(
          db,
          schema,
          collection,
          record as Row,
          'password',
        );
      } catch (error) {
        // Created, but with no second step to take yet: it says so, unlike
        // an authRule refusal, so the app can ask to verify the email.
        if (error instanceof ApiError && error.status === 403) {
          return Response.json({ mfa: 'verify' }, { status: 202 });
        }
        throw error;
      }
      if (challenge) throw new MfaRequired(challenge);
      return startSession(context, collection, record as Row, cookie === true, [
        'password',
      ]);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/collections/${segment}/auth-refresh$`),
    tags: ['auth'],
    async handler(context) {
      const { request, params, schema, principal, db } = context;
      const collection = authCollection(schema, params[0] as string);
      const record = recordIn(principal, collection, 'refresh');
      const { session } = principal;
      if (!session) {
        throw new ApiError(401, 'Sign in to this collection to refresh.');
      }
      forbidImpersonated(principal, 'be refreshed');
      await checkAuthRule(db, schema, collection, record.id as string);
      const body = await authRecord(context, collection, record);
      const expires = await extendSession(db, collection, session.id);
      if (!principal.viaCookie) {
        return authResponse(body, bearerToken(request), session.methods);
      }
      const response = authResponse(body, undefined, session.methods);
      const token = sessionCookie(request);
      if (token) {
        response.headers.append(
          'set-cookie',
          setSessionCookie(request, { token, expires }),
        );
      }
      return response;
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/collections/${segment}/impersonate/${segment}$`),
    // Only superusers may, and they skip rate limits, but it starts a
    // session like the sign-ins.
    tags: ['auth'],
    handler: impersonate,
  },
  {
    method: 'GET',
    pattern: /^\/session$/,
    async handler({ principal }) {
      const { collection, record, session } = principal;
      if (!collection || !record || !session) return Response.json(null);
      return Response.json({
        ...sessionModel(session, true),
        record: serializeRecord(collection, record, principal),
      });
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/session$/,
    async handler(context) {
      const { request, db, schema, principal } = context;
      if (principal.session) await deleteSession(db, principal.session);
      const restored = await restoredSession(request, db, schema, principal);
      // The superuser is signed in again, so the client can say who.
      const response = restored
        ? authResponse(
            await authRecord(context, restored.collection, restored.record),
            undefined,
            restored.methods,
          )
        : new Response(null, { status: 204 });
      // Removed even when the session was already gone, but not when a
      // superuser acting as someone by token leaves: the cookie is their own.
      const tokenImpersonation =
        principal.impersonatedBy !== undefined && !principal.viaCookie;
      if (request.headers.has('cookie') && !tokenImpersonation) {
        response.headers.append(
          'set-cookie',
          setSessionCookie(request, restored),
        );
      }
      if (impersonatorCookie(request) !== undefined && !tokenImpersonation) {
        response.headers.append('set-cookie', setImpersonatorCookie(request));
      }
      return response;
    },
  },
  {
    method: 'GET',
    pattern: /^\/sessions$/,
    async handler({ db, principal }) {
      const current = requireSession(principal);
      const items = await listSessions(
        db,
        current.collectionId,
        current.recordId,
      );
      return Response.json({
        items: items.map((s) => sessionModel(s, s.id === current.id)),
      });
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/sessions$/,
    async handler({ db, principal }) {
      const current = requireSession(principal);
      forbidImpersonated(principal, 'revoke other sessions');
      await deleteOtherSessions(db, current);
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/sessions/${segment}$`),
    async handler({ request, params, db, principal }) {
      const current = requireSession(principal);
      const id = params[0] as string;
      // Its own session it may end, as by signing out.
      if (id !== current.id)
        forbidImpersonated(principal, 'revoke other sessions');
      const deleted = await deleteSession(db, {
        id,
        collectionId: current.collectionId,
        recordId: current.recordId,
      });
      if (!deleted) throw new ApiError(404, 'Session not found.');
      const response = new Response(null, { status: 204 });
      if (id === current.id && principal.viaCookie) {
        response.headers.append('set-cookie', setSessionCookie(request));
      }
      return response;
    },
  },
  {
    method: 'GET',
    pattern: /^\/logs$/,
    transaction: true,
    async handler(context) {
      requireSuperuser(context.principal);
      const list = await bounded(context, (db) =>
        listRecords(
          recordsContext(context, {}, { db }),
          logsCollection(),
          parse(context).url.searchParams,
        ),
      );
      return Response.json({ ...list, items: list.items.map(logModel) });
    },
  },
  // Before `/logs/{id}`, which would match it too.
  {
    method: 'GET',
    pattern: /^\/logs\/stats$/,
    transaction: true,
    async handler(context) {
      requireSuperuser(context.principal);
      const filter = parse(context).url.searchParams.get('filter') ?? '';
      return Response.json(
        await bounded(context, (db) => logStats(db, context, filter)),
      );
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/logs/${segment}$`),
    transaction: true,
    async handler(context) {
      requireSuperuser(context.principal);
      const entry = await bounded(context, (db) =>
        viewRecord(
          recordsContext(context, {}, { db }),
          logsCollection(),
          context.params[0] as string,
          parse(context).url.searchParams,
        ),
      ).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) {
          throw new ApiError(404, 'Log entry not found.');
        }
        throw error;
      });
      return Response.json(logModel(entry));
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/logs$/,
    async handler({ db, principal }) {
      requireSuperuser(principal);
      await deleteLogs(db);
      return new Response(null, { status: 204 });
    },
  },
];

/**
 * Opens a route's transaction. Starting it, setting the timeout and reading
 * the schema version take one round trip together.
 */
export function beginRoute(db: DB, statementTimeout: number): Promise<Tx> {
  return db.begin(txOptions(statementTimeout, SCHEMA_VERSION_SQL));
}

/**
 * Runs records API work in a transaction limited by `statementTimeout`. It
 * uses the route's transaction if there is one, or opens a new one. The
 * timeout lasts only until the transaction ends, so it works through
 * transaction poolers.
 */
async function bounded<T>(
  context: Context,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (context.tx) return run(context.tx);
  const result = await context.db.transaction(
    run,
    txOptions(context.statementTimeout),
  );
  // What follows its writes is done even if the request fails after this,
  // as a sign-up may when it starts the session.
  context.effects.commit();
  return result;
}

function txOptions(statementTimeout: number, startQuery?: string): TxOptions {
  return {
    // With 0, the database's own timeout applies.
    ...(statementTimeout > 0 && { statementTimeout }),
    ...(startQuery !== undefined && { startQuery }),
  };
}

function parse({ request }: Context): { url: URL } {
  return { url: new URL(request.url) };
}

/**
 * The `@request.*` values rules may read. Reads made while a write is planned
 * use the transaction of the hook that sent the request, if any, so they see
 * what it wrote.
 */
function recordsContext(
  context: Context,
  body: Record<string, unknown>,
  {
    db = context.tx ?? context.db,
    method = context.request.method,
    query,
  }: {
    db?: DB | Tx;
    method?: string;
    query?: URLSearchParams;
  } = {},
): RecordsContext {
  const { request, schema, principal } = context;
  return {
    db,
    pool: context.db,
    schema,
    principal,
    rejectBreachedPasswords: context.rejectBreachedPasswords,
    effects: context.effects,
    storage: context.storage,
    hooks: context.hooks,
    hookChain: context.hookChain,
    mfa: context.mfa,
    request: {
      method,
      query: Object.fromEntries(query ?? new URL(request.url).searchParams),
      headers: Object.fromEntries(request.headers),
      body,
    },
  };
}

interface Reply {
  status: number;
  body?: unknown;
}

function replyOf({ status, body }: Reply): Response {
  return body === undefined
    ? new Response(null, { status })
    : Response.json(body, { status });
}

interface RecordWrite {
  method: 'POST' | 'PATCH' | 'DELETE';
  collection: string;
  id?: string;
  body: Record<string, unknown>;
  query: URLSearchParams;
}

/** Plans the write, then runs it in its own transaction. */
async function writeRecord(
  context: Context,
  write: RecordWrite,
): Promise<Reply> {
  const planned = await planRecordWrite(context, write);
  if ('apply' in planned) return bounded(context, planned.apply);
  const apply = applyCreate(planned.create);
  return bounded(context, async (tx) => replyWith(await apply(tx)));
}

/**
 * A write checked as far as it can be before its transaction starts. A batch
 * does consecutive creates together, so they stay planned creates; other
 * writes come with the rest of their work.
 */
type PlannedWrite = { create: PlannedCreate } | { apply: Apply<Reply> };

/** Plans a write; see `PlannedWrite`. */
async function planRecordWrite(
  context: Context,
  write: RecordWrite,
  written?: ReadonlySet<string>,
): Promise<PlannedWrite> {
  const collection = context.schema.get(write.collection);
  const ctx = {
    ...recordsContext(context, write.body, {
      method: write.method,
      query: write.query,
    }),
    ...(written && { written }),
  };
  if (write.method === 'POST') {
    return {
      create: await planNewRecord(ctx, collection, write.body, write.query),
    };
  }
  if (write.method === 'DELETE') {
    const apply = await planDeleteRecord(ctx, collection, write.id as string);
    return {
      apply: async (tx) => {
        await apply(tx);
        return { status: 204 };
      },
    };
  }
  const apply = await planUpdateRecord(
    ctx,
    collection,
    write.id as string,
    write.body,
    write.query,
  );
  return { apply: async (tx) => replyWith(await apply(tx)) };
}

/** 204 when the caller may not view the record. */
function replyWith(record: Record<string, unknown> | undefined): Reply {
  return record ? { status: 200, body: record } : { status: 204 };
}

/** Reports which write of a batch failed, and that nothing was saved. */
async function inBatch<T>(i: number, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw batchError(i, error);
  }
}

function batchError(i: number, error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  return new ApiError(
    400,
    `Request ${i + 1} of the batch failed with ${error.status}: ${error.message} Nothing was saved.`,
    { requests: { [i]: error.data } },
  );
}

const MAX_BATCH = 50;

const WRITE_TAGS = {
  POST: 'create',
  PATCH: 'update',
  DELETE: 'delete',
} as const satisfies Record<RecordWrite['method'], RouteTag>;

// `{ requests: [{ method, url, body }] }`, each url a records path below the base path.
/** A write of a batch, with its records path. */
interface BatchWrite extends RecordWrite {
  path: string;
}

function parseBatch(input: Record<string, unknown>): BatchWrite[] {
  const { requests } = input;
  if (
    !Array.isArray(requests) ||
    requests.length === 0 ||
    requests.length > MAX_BATCH
  ) {
    throw new ApiError(400, 'The batch is invalid.', {
      requests: {
        code: 'validation_invalid',
        message: `Must be a list of 1 to ${MAX_BATCH} requests.`,
      },
    });
  }
  return requests.map((request: unknown, i): BatchWrite => {
    const invalid = (message: string): ApiError =>
      new ApiError(400, 'The batch is invalid.', {
        requests: { [i]: { code: 'validation_invalid', message } },
      });
    if (
      request === null ||
      typeof request !== 'object' ||
      Array.isArray(request)
    )
      throw invalid('Must be an object.');
    const { method, url, body = {} } = request as Record<string, unknown>;
    if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE')
      throw invalid('method must be POST, PATCH or DELETE.');
    if (typeof url !== 'string' || !url.startsWith('/'))
      throw invalid(
        'url must be a records path such as /collections/posts/records.',
      );
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw invalid('body must be an object.');
    const parsed = new URL(url, 'http://batch.invalid');
    const match = (method === 'POST' ? records : record).exec(parsed.pathname);
    if (!match) {
      throw invalid(
        method === 'POST'
          ? 'POST creates records: /collections/{collection}/records.'
          : `${method} needs a record: /collections/{collection}/records/{id}.`,
      );
    }
    const [collection, id] = match
      .slice(1)
      .map((p) => decodeURIComponent(p)) as [string, string | undefined];
    return {
      method,
      path: parsed.pathname,
      collection,
      ...(id !== undefined && { id }),
      body: body as Record<string, unknown>,
      query: parsed.searchParams,
    };
  });
}

function flowContext(context: Context): FlowContext {
  const { db, schema, mailer, rejectBreachedPasswords, effects, hooks, mfa } =
    context;
  return { db, schema, mailer, rejectBreachedPasswords, effects, hooks, mfa };
}

/**
 * Sends the verification link a collection sends by itself, on sign-up or
 * sign-in. It never fails the request: a link refused for being too soon
 * after the last one is not needed, and other failures are logged.
 */
async function sendVerification(
  context: Context,
  collection: AuthCollection,
  email: string,
): Promise<void> {
  try {
    await requestEmailVerification(flowContext(context), collection, email);
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) return;
    context.logger.failure(
      'mail',
      'sending a verification email failed',
      error,
    );
  }
}

/**
 * The `params` and `data` of a sign-in, each a JSON object, as the query
 * of `auth-with-oauth2` carries them.
 */
function extras(
  params: string | null,
  data: string | null,
): { params: Record<string, string>; data: Record<string, unknown> | null } {
  const json = (text: string, field: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(400, `${field} must be JSON.`, {
        [field]: { code: 'validation_invalid_value', message: 'Must be JSON.' },
      });
    }
  };
  return {
    params:
      params === null
        ? {}
        : checkParams(json(params, 'params'), 'params', 'params'),
    data: data === null ? null : checkData(json(data, 'data')),
  };
}

/** Thrown to roll back a rehearsed write once it succeeded. */
class Rehearsed extends Error {}

/**
 * Runs a write in a transaction that is always rolled back: it throws what
 * the write would, and otherwise leaves nothing, not even its files.
 */
async function rehearse(context: Context, write: RecordWrite): Promise<void> {
  const effects = new Effects();
  const run = async (tx: Tx): Promise<never> => {
    await writeRecord({ ...context, tx, effects }, write);
    throw new Rehearsed();
  };
  try {
    if (context.tx) await context.tx.transaction(run);
    else await context.db.transaction(run, txOptions(context.statementTimeout));
  } catch (error) {
    if (error instanceof Rehearsed) {
      context.effects.obsoleteFiles.push(...effects.newFiles);
      return;
    }
    context.effects.newFiles.push(...effects.newFiles);
    throw error;
  }
}

/** An address nobody has, at the same domain, so domain checks still apply. */
function unusedEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${newId()}${at === -1 ? '' : email.slice(at)}`;
}

/** Whether a write failed only because its email is registered already. */
function takenEmail(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const fields = Object.keys(error.data);
  return (
    fields.length === 1 &&
    (error.data.email as { code?: unknown } | undefined)?.code ===
      'validation_not_unique'
  );
}

/**
 * Emails the owner of an account someone tried to sign up with again, at
 * most as often as other emails to that address.
 */
async function tellOwnerOfSignUp(
  context: Context,
  collection: AuthCollection,
  email: string,
): Promise<void> {
  const { db, mailer } = context;
  const owner = await findByEmail(db, collection, email);
  if (!owner) return;
  try {
    mailer.check();
    await countAttempt(db, [mailKey(collection.id, owner.email as string)]);
  } catch {
    // No email set up, or one sent too recently: nothing to add.
    return;
  }
  mailer.send('signUpAttempt', collection.name, owner.email as string);
}

// Always 204, so it does not reveal which accounts exist. None is open to
// an impersonation session: each proves, changes or recovers a way in.
function flow(
  name: string,
  run: (
    ctx: FlowContext,
    collection: AuthCollection,
    input: Record<string, unknown>,
    principal: Principal,
  ) => Promise<void>,
): Route[] {
  return [
    {
      method: 'POST',
      pattern: new RegExp(`^/collections/${segment}/${name}$`),
      tags: ['auth'],
      async handler(context) {
        const { request, params, schema, principal } = context;
        const collection = authCollection(schema, params[0] as string);
        forbidImpersonated(principal, 'change sign-in details');
        const input = await readJsonObject(request);
        await run(flowContext(context), collection, input, principal);
        return new Response(null, { status: 204 });
      },
    },
  ];
}

// Always 204, so it does not reveal which phones have accounts.
function phoneFlow(
  name: string,
  run: (
    ctx: PhoneContext,
    collection: AuthCollection,
    input: Record<string, unknown>,
    principal: Principal,
  ) => Promise<void>,
): Route[] {
  return [
    {
      method: 'POST',
      pattern: new RegExp(`^/collections/${segment}/${name}$`),
      tags: ['auth'],
      async handler(context) {
        const { request, params, schema, principal } = context;
        const collection = authCollection(schema, params[0] as string);
        forbidImpersonated(principal, 'change sign-in details');
        const input = await readJsonObject(request);
        await run(phoneContext(context), collection, input, principal);
        return new Response(null, { status: 204 });
      },
    },
  ];
}

function phoneContext({
  db,
  schema,
  sms,
  mailer,
  rejectBreachedPasswords,
  effects,
  hooks,
  mfa,
}: Context): PhoneContext {
  return {
    db,
    schema,
    sms,
    mailer,
    rejectBreachedPasswords,
    effects,
    hooks,
    mfa,
  };
}

/**
 * Answers with the token in the body, or with `cookie` in an HttpOnly cookie.
 * A cookie sign-in ends the replaced cookie's session, so a planted session never signs in.
 */
async function startSession(
  context: Context,
  collection: AuthCollection,
  record: Record<string, unknown>,
  cookie: boolean,
  methods: readonly SignInMethod[],
): Promise<Response> {
  const { request, db, principal } = context;
  // Before the session starts, so a refused `expand` or `fields` starts none.
  const body = await authRecord(context, collection, record);
  if (cookie && principal.viaCookie && principal.session) {
    await deleteSession(db, principal.session);
  }
  const { token, session } = await createSession(
    db,
    collection,
    record,
    request.headers.get('user-agent') ?? '',
    { methods },
  );
  const response = authResponse(
    body,
    cookie ? undefined : token,
    session.methods,
  );
  if (cookie) {
    response.headers.append(
      'set-cookie',
      setSessionCookie(request, { token, expires: session.expires }),
    );
  }
  return response;
}

/**
 * The record of an auth response, with the query's `expand` and `fields`.
 * Rules see the account it signs in, as on its next request.
 */
function authRecord(
  context: Context,
  collection: AuthCollection,
  record: Record<string, unknown>,
  impersonatedBy?: string,
): Promise<Record<string, unknown>> {
  const principal: Principal = {
    collection,
    record,
    superuser: collection.id === SUPERUSERS,
    ...(impersonatedBy !== undefined && { impersonatedBy }),
  };
  return outputRecord(
    recordsContext({ ...context, principal }, {}),
    collection,
    record,
    new URL(context.request.url).searchParams,
  );
}

function authResponse(
  record: Record<string, unknown>,
  token: string | undefined,
  methods: readonly string[],
): Response {
  return Response.json({
    ...(token !== undefined && { token }),
    record,
    methods,
  });
}

/**
 * After a first step: the session, or the 401 that asks for a second step
 * when the record must take one. No session starts before that.
 */
async function completeSignIn(
  context: Context,
  collection: AuthCollection,
  record: Row,
  method: SignInMethod,
  cookie: boolean,
): Promise<Response> {
  const { db, schema, mfa } = context;
  const challenge = await mfa.challenge(db, schema, collection, record, method);
  if (challenge) throw new MfaRequired(challenge);
  return startSession(context, collection, record, cookie, [method]);
}

interface Step {
  pending: Pending;
  /** Named by this browser's cookie, after an OAuth2 first step. */
  viaCookie: boolean;
}

/** A second step named by the body's `mfaId`, checked to allow `method`. */
async function bodyStep(
  context: Context,
  collection: AuthCollection,
  mfaId: unknown,
  method: SignInMethod,
): Promise<Step> {
  const pending = await context.mfa.pending(context.db, collection, mfaId);
  await context.mfa.allow(context.db, pending, method);
  return { pending, viaCookie: false };
}

/**
 * The sign-in of the body's `mfaId`, or else of this browser's cookie.
 * Browsers send the cookie with requests other sites make, so using it
 * needs a request from this site.
 */
async function requiredStep(
  context: Context,
  collection: AuthCollection,
  input: Record<string, unknown>,
): Promise<Step> {
  const { request, db, mfa, inProcess, origins } = context;
  if (input.mfaId !== undefined) {
    return {
      pending: await mfa.pending(db, collection, input.mfaId),
      viaCookie: false,
    };
  }
  const cookie = mfaCookie(request);
  if (cookie === undefined) throw invalidMfa();
  if (!inProcess) checkSameOrigin(request, origins);
  return {
    pending: await mfa.pending(db, collection, cookie),
    viaCookie: true,
  };
}

/**
 * The cookie's sign-in, when a first-step route signed in its record and it
 * can take that step: then the request finishes it. Otherwise the cookie
 * is left be, so an old one never stops another sign-in.
 */
async function cookieStep(
  context: Context,
  collection: AuthCollection,
  record: Row,
  method: SignInMethod,
): Promise<Step | undefined> {
  const { request, db, mfa, inProcess, origins } = context;
  const cookie = mfaCookie(request);
  if (cookie === undefined) return undefined;
  try {
    if (!inProcess) checkSameOrigin(request, origins);
    const pending = await mfa.pending(db, collection, cookie);
    if (pending.record.id !== record.id) return undefined;
    await mfa.allow(db, pending, method);
    return { pending, viaCookie: true };
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) return undefined;
    throw error;
  }
}

/**
 * Ends a sign-in with its second step: the session records both methods.
 * One named by the cookie gets a cookie session, and the cookie is removed.
 */
async function finishStep(
  context: Context,
  { pending, viaCookie }: Step,
  method: SignInMethod,
  cookie: boolean,
): Promise<Response> {
  const { request, db, schema, mfa } = context;
  const { collection, record } = pending;
  await checkAuthRule(db, schema, collection, record.id as string);
  const methods = await mfa.finish(db, pending, method);
  const response = await startSession(
    context,
    collection,
    record,
    cookie || viaCookie,
    methods,
  );
  if (mfaCookie(request) !== undefined) {
    response.headers.append('set-cookie', setMfaCookie(request));
  }
  return response;
}

/** A route that takes the second step of a sign-in with a code. */
function secondStep(
  name: string,
  method: 'totp' | 'recoveryCode' | 'emailCode',
): Route[] {
  return [
    {
      method: 'POST',
      pattern: new RegExp(`^/collections/${segment}/${name}$`),
      tags: ['auth'],
      async handler(context) {
        const { request, params, db, schema, inProcess, origins, mfa } =
          context;
        const collection = authCollection(schema, params[0] as string);
        const input = await readJsonObject(request);
        const { code, cookie } = input;
        // Another site must not sign the browser in to an account of its choosing.
        if (cookie === true && !inProcess) checkSameOrigin(request, origins);
        const step = await requiredStep(context, collection, input);
        await mfa.verifyCode(db, step.pending, method, code);
        return finishStep(context, step, method, cookie === true);
      },
    },
  ];
}

/**
 * The second step of a sign-in by an OAuth2 provider. It only proves a
 * provider account already linked to the record: it never links one or
 * signs up. It ends with a cookie session, as OAuth2 sign-ins do.
 */
async function oauth2Step(
  context: Context,
  collection: AuthCollection,
  mfaIdHash: string,
  {
    provider,
    identity,
    back,
  }: { provider: string; identity: Identity; back: () => Response },
): Promise<Response> {
  const { request, db, schema, principal, mfa, oauth2 } = context;
  let pending: Pending;
  try {
    pending = await mfa.pendingByHash(db, collection, mfaIdHash);
    await mfa.allow(db, pending, 'oauth2');
  } catch (error) {
    if (error instanceof ApiError) {
      throw new OAuth2Error('mfa_failed', error.message);
    }
    throw error;
  }
  const linked = await findLinked(db, collection, provider, identity.id);
  if (linked?.id !== pending.record.id) {
    throw new OAuth2Error(
      'mfa_failed',
      'This provider account is not linked to the account signing in.',
    );
  }
  if (identity.tokens) {
    await oauth2.saveTokens(
      db,
      collection.id,
      pending.record.id as string,
      provider,
      identity.tokens,
    );
  }
  let methods: SignInMethod[];
  try {
    await checkAuthRule(db, schema, collection, pending.record.id as string);
    methods = await mfa.finish(db, pending, 'oauth2');
  } catch (error) {
    if (error instanceof ApiError) {
      throw new OAuth2Error(
        error.status === 403 ? 'sign_in_forbidden' : 'mfa_failed',
        error.message,
      );
    }
    throw error;
  }
  // As on any cookie sign-in, the session in the cookie is replaced.
  if (principal.viaCookie && principal.session) {
    await deleteSession(db, principal.session);
  }
  const { token, session } = await createSession(
    db,
    collection,
    pending.record,
    request.headers.get('user-agent') ?? '',
    { methods },
  );
  const response = back();
  response.headers.append(
    'set-cookie',
    setSessionCookie(request, { token, expires: session.expires }),
  );
  if (mfaCookie(request) !== undefined) {
    response.headers.append('set-cookie', setMfaCookie(request));
  }
  return response;
}

/**
 * Starts a session in which the calling superuser acts as the record, like
 * a sign-in that skips the collection's auth rule. It lasts `duration`
 * seconds and is never extended. With `cookie`, the superuser's own cookie
 * session is kept in another cookie, and signing out restores it.
 */
async function impersonate(context: Context): Promise<Response> {
  const { request, params, db, schema, principal, inProcess, origins } =
    context;
  forbidImpersonated(principal, 'impersonate');
  requireSuperuser(principal);
  const superuser = principal.record;
  if (!superuser || !principal.collection || !principal.session) {
    throw new ApiError(403, 'Sign in as a superuser to impersonate.');
  }
  const collection = authCollection(schema, params[0] as string);
  if (collection.id === SUPERUSERS) {
    throw new ApiError(403, 'Superusers cannot be impersonated.');
  }
  const { duration = IMPERSONATION_DURATION.max, cookie } =
    await readJsonObject(request);
  const { min, max } = IMPERSONATION_DURATION;
  if (
    typeof duration !== 'number' ||
    !Number.isInteger(duration) ||
    duration < min ||
    duration > max
  ) {
    throw new ApiError(400, 'Failed to impersonate.', {
      duration: {
        code: 'validation_invalid_value',
        message: `Must be a whole number of seconds from ${min} to ${max}.`,
      },
    });
  }
  // The superuser's own cookie session is kept aside, to be restored.
  if (cookie === true && !principal.viaCookie) {
    throw new ApiError(
      400,
      'Impersonation in cookie mode needs a cookie session.',
    );
  }
  // Another site must not sign the browser in to an account of its choosing.
  if (cookie === true && !inProcess) checkSameOrigin(request, origins);
  const id = params[1] as string;
  const [record] = await db
    .select()
    .from(table(collection.name))
    .where(hash({ id }))
    .all();
  if (!record) throw new ApiError(404, 'Record not found.');
  const superuserId = superuser.id as string;
  // Before the session starts, so a refused `expand` or `fields` starts none.
  const body = await authRecord(context, collection, record, superuserId);
  const { token, session } = await createSession(
    db,
    collection,
    record,
    request.headers.get('user-agent') ?? '',
    {
      duration,
      impersonator: { collection: principal.collection, record: superuser },
      // It skips the record's sign-in steps, so it counts as none of them.
      methods: [IMPERSONATION],
    },
  );
  context.logger.audit('Impersonation started', {
    type: 'impersonate',
    superuserId,
    collection: collection.name,
    recordId: id,
    sessionId: session.id,
    expires: session.expires.toISOString(),
  });
  const response = Response.json({
    ...(cookie !== true && { token }),
    record: body,
    methods: session.methods,
    session: sessionModel(session, false),
  });
  const own = sessionCookie(request);
  if (cookie === true && own !== undefined) {
    // Kept as long as the impersonation lasts, to be restored when it ends.
    response.headers.append(
      'set-cookie',
      setImpersonatorCookie(request, { token: own, expires: session.expires }),
    );
    response.headers.append(
      'set-cookie',
      setSessionCookie(request, { token, expires: session.expires }),
    );
  }
  return response;
}

/**
 * Signing out of an impersonation session in the browser that started it
 * gives the superuser back their own session, if it is still valid.
 */
async function restoredSession(
  request: Request,
  db: DB,
  schema: Schema,
  principal: Principal,
): Promise<
  | {
      token: string;
      expires: Date;
      methods: SignInMethod[];
      collection: AuthCollection;
      record: Row;
    }
  | undefined
> {
  const kept = impersonatorCookie(request);
  if (
    kept === undefined ||
    !principal.viaCookie ||
    principal.impersonatedBy === undefined
  ) {
    return undefined;
  }
  const active = await sessionIn(db, schema, kept);
  if (
    active?.collection.id !== SUPERUSERS ||
    active.record.id !== principal.impersonatedBy
  ) {
    return undefined;
  }
  return {
    token: kept,
    expires: active.session.expires,
    methods: active.session.methods,
    collection: active.collection,
    record: active.record,
  };
}

function requireSession(principal: Principal): Session {
  if (!principal.session)
    throw new ApiError(401, 'Sign in to manage sessions.');
  return principal.session;
}

// Only the record itself and superusers; anyone else gets 404 so nothing leaks.
function ownRecord(
  schema: Schema,
  principal: Principal,
  params: string[],
): { collection: AuthCollection; id: string } {
  const collection = authCollection(schema, params[0] as string);
  const id = params[1] as string;
  if (!principal.superuser && !principal.record) {
    throw new ApiError(401, 'Sign in to manage linked accounts.');
  }
  const own =
    principal.collection?.id === collection.id && principal.record?.id === id;
  if (!principal.superuser && !own) {
    throw new ApiError(404, 'Record not found.');
  }
  return { collection, id };
}

/**
 * The caller's own record and session, for MFA settings: only the record
 * itself, never a superuser for another, and never while impersonating, as
 * each could leave a way into the account.
 */
function ownMfa(
  schema: Schema,
  principal: Principal,
  params: string[],
): { collection: AuthCollection; record: Row; session: Session } {
  const collection = authCollection(schema, params[0] as string);
  const { record, session } = principal;
  if (!record || !session) {
    throw new ApiError(401, 'Sign in to manage multi-factor sign-in.');
  }
  forbidImpersonated(principal, 'manage multi-factor sign-in');
  if (principal.collection?.id !== collection.id || record.id !== params[1]) {
    throw new ApiError(404, 'Record not found.');
  }
  return { collection, record, session };
}

function authCollection(schema: Schema, idOrName: string): AuthCollection {
  const collection: Collection = schema.get(idOrName);
  if (collection.type !== 'auth')
    throw new ApiError(404, 'Collection not found.');
  return collection;
}

// Data that blocks the DDL (e.g. duplicates under a new unique index) is a 400, not a 500.
async function schemaChange<T>(change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    // Class 23: integrity constraint violations.
    if (typeof code === 'string' && code.startsWith('23')) {
      throw new ApiError(
        400,
        `The change conflicts with existing records: ${String(message)}`,
      );
    }
    // A view reads what the change would drop or retype.
    if (
      code === '2BP01' ||
      (code === '0A000' && /\bview\b/.test(String(message)))
    ) {
      throw new ApiError(
        400,
        `A view depends on what this change removes: ${String(message)}. Update or delete that view first.`,
      );
    }
    throw error;
  }
}
