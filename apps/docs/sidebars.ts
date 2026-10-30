import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const doc = (id: string, label: string, icon: string) => ({
  type: 'doc' as const,
  id,
  label,
  className: `sidebar-item-icon sidebar-icon-${icon}`,
});

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Get started',
      className: 'sidebar-icon sidebar-icon-start',
      items: ['index', 'getting-started'],
    },
    {
      type: 'category',
      label: 'Concepts',
      className: 'sidebar-icon sidebar-icon-concepts',
      items: [
        'guides/collections',
        'guides/records',
        'guides/filters',
        'guides/rules',
        'guides/hooks',
        'guides/realtime',
        'guides/files',
        'guides/auth/sessions',
        'guides/auth/email',
        'guides/auth/verification',
        'guides/auth/password-reset',
        'guides/auth/email-change',
      ],
    },
    {
      type: 'category',
      label: 'Authentication',
      className: 'sidebar-icon sidebar-icon-auth',
      items: [
        doc('guides/auth/index', 'Overview', 'info'),
        doc('guides/auth/email-password', 'Email & Password', 'mail'),
        doc('guides/auth/oauth2', 'OAuth2', 'key'),
        doc('guides/auth/phone', 'Phone', 'phone'),
        doc('guides/auth/mfa', 'Multi-factor', 'key'),
        doc('guides/auth/impersonation', 'Impersonation', 'user'),
      ],
    },
    {
      type: 'category',
      label: 'Integrations',
      className: 'sidebar-icon sidebar-icon-integrations',
      items: [{ type: 'doc', id: 'integrations/nextjs', label: 'Next.js' }],
    },
    {
      type: 'category',
      label: 'Production',
      className: 'sidebar-icon sidebar-icon-production',
      items: ['guides/production', 'guides/logs', 'guides/rate-limits'],
    },
    {
      type: 'category',
      label: 'Reference',
      className: 'sidebar-icon sidebar-icon-reference',
      items: [
        { type: 'doc', id: 'api/index', label: 'REST API' },
        { type: 'doc', id: 'api/records', label: 'Records' },
        { type: 'doc', id: 'api/auth', label: 'Auth' },
        { type: 'doc', id: 'api/files', label: 'Files' },
        { type: 'doc', id: 'api/realtime', label: 'Realtime' },
        { type: 'doc', id: 'api/collections', label: 'Collections' },
        { type: 'doc', id: 'api/logs', label: 'Logs' },
        { type: 'doc', id: 'api/setup', label: 'Setup and health' },
        { type: 'doc', id: 'sdk/index', label: 'Client SDK' },
      ],
    },
  ],
};

export default sidebars;
