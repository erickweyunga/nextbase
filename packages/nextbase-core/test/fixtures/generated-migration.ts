import { type Migration, migration } from '../../src/index.ts';

// As automigrate writes an auth collection's update; the package typecheck checks it.
export const generated: Migration = migration({
  async up(app) {
    await app.collections.change<'auth'>('users0000000001', (c) => {
      c.listRule = null;
      c.mfa.duration = 600;
      c.otp.enabled = true;
      c.emailVerification.required = true;
      c.tokens.auth.duration = 3600;
      c.passkeySignIn = true;
      c.fields.addAt(3, {
        id: 'text000002',
        name: 'bio',
        type: 'text',
      });
      c.fields.removeById('text000001');
    });
  },
});
