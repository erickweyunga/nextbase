import { styled, type Theme } from 'baseui';
import { PLACEMENT } from 'baseui/popover';
import { Fragment, type ReactNode } from 'react';
import type { StyleObject } from 'styletron-react';
import { Link } from '../navigation';
import { Popover } from '../popover/popover';
import { useSidebar } from '../sidebar/sidebar';

const Trigger = styled('button', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale500,
  width: '100%',
  minWidth: 0,
  padding: 0,
  paddingBlock: $theme.sizing.scale300,
  borderWidth: 0,
  borderRadius: $theme.borders.radius300,
  backgroundColor: 'transparent',
  font: 'inherit',
  textAlign: 'start',
  cursor: 'pointer',
  ':focus-visible': {
    outline: `2px solid ${$theme.colors.borderAccent}`,
    outlineOffset: '2px',
  },
}));

const Avatar = styled<'span', { $large?: boolean }>(
  'span',
  ({ $theme, $large }) => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: $large ? '48px' : '40px',
    height: $large ? '48px' : '40px',
    borderRadius: '50%',
    backgroundColor: $theme.colors.backgroundTertiary,
    color: $theme.colors.contentTertiary,
  }),
);

const AvatarImage = styled('img', {
  width: '100%',
  height: '100%',
  borderRadius: '50%',
  objectFit: 'cover',
});

const Text = styled<'span', { $faded?: boolean }>(
  'span',
  ({ $theme, $faded }) => ({
    display: 'grid',
    minWidth: 0,
    opacity: $faded ? 0 : 1,
    transitionProperty: 'opacity',
    transitionDuration: $theme.animation.timing200,
  }),
);

const Name = styled('span', ({ $theme }) => ({
  ...$theme.typography.LabelMedium,
  color: $theme.colors.contentPrimary,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}));

const Email = styled('span', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  color: $theme.colors.contentTertiary,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}));

const Panel = styled('div', ({ $theme }) => ({
  display: 'grid',
  width: '280px',
  paddingBlock: $theme.sizing.scale300,
}));

const Header = styled('div', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale500,
  padding: $theme.sizing.scale500,
}));

const ProfileBox = styled('div', ({ $theme }) => ({
  marginInline: $theme.sizing.scale300,
  marginBottom: $theme.sizing.scale300,
  overflow: 'hidden',
  border: `1px solid ${$theme.colors.borderOpaque}`,
  borderRadius: $theme.borders.radius300,
}));

const BoxDivider = styled('hr', ({ $theme }) => ({
  margin: 0,
  borderWidth: 0,
  borderTop: `1px solid ${$theme.colors.borderOpaque}`,
}));

const Separator = styled('hr', ({ $theme }) => ({
  marginBlock: 0,
  marginInline: $theme.sizing.scale600,
  borderWidth: 0,
  borderTop: `${$theme.borders.border200.borderWidth} solid ${$theme.borders.border200.borderColor}`,
}));

type Tone = 'default' | 'accent' | 'danger';

const itemStyle = ({
  $theme,
  $tone = 'default',
}: {
  $theme: Theme;
  $tone?: Tone;
}): StyleObject => ({
  ...$theme.typography.LabelMedium,
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale500,
  width: '100%',
  paddingBlock: $theme.sizing.scale400,
  paddingInline: $theme.sizing.scale600,
  borderWidth: 0,
  backgroundColor: 'transparent',
  color: {
    default: $theme.colors.contentPrimary,
    accent: $theme.colors.contentAccent,
    danger: $theme.colors.contentNegative,
  }[$tone],
  textAlign: 'start',
  textDecoration: 'none',
  cursor: 'pointer',
  ':hover': { backgroundColor: $theme.colors.backgroundSecondary },
  ':focus-visible': {
    outline: 'none',
    backgroundColor: $theme.colors.backgroundSecondary,
  },
});

const ItemLink = styled<typeof Link, { $tone?: Tone }>(Link, itemStyle);
const ItemButton = styled<'button', { $tone?: Tone }>('button', itemStyle);

/** A menu entry: a link with `href`, or an action with `onSelect`. The menu closes either way. */
export interface AccountMenuItem {
  label: string;
  icon?: ReactNode;
  href?: string;
  onSelect?: () => void;
  tone?: Tone;
}

export interface AccountMenuProps {
  name: string;
  email: string;
  avatarUrl?: string | null;
  /** Shown in the avatar without a picture, at the given size in px. */
  placeholder: (size: number) => ReactNode;
  /** Below the profile, inside its box, e.g. a workspace switcher. */
  profileExtra?: (close: () => void) => ReactNode;
  /** Groups of entries, with a line between groups. */
  groups: AccountMenuItem[][];
}

function AvatarContent({
  url,
  size,
  placeholder,
}: {
  url?: string | null;
  size: number;
  placeholder: AccountMenuProps['placeholder'];
}) {
  return url ? (
    <AvatarImage src={url} alt="" width={size} height={size} />
  ) : (
    placeholder(size / 2)
  );
}

/** The signed-in person at the foot of a sidebar; opens their account menu. */
export function AccountMenu({
  name,
  email,
  avatarUrl,
  placeholder,
  profileExtra,
  groups,
}: AccountMenuProps) {
  const { collapsed } = useSidebar();

  return (
    <Popover
      placement={PLACEMENT.topLeft}
      content={(close) => (
        <Panel>
          <ProfileBox>
            <Header>
              <Avatar $large>
                <AvatarContent
                  url={avatarUrl}
                  size={48}
                  placeholder={placeholder}
                />
              </Avatar>
              <Text>
                <Name>{name}</Name>
                <Email title={email}>{email}</Email>
              </Text>
            </Header>
            {profileExtra && (
              <>
                <BoxDivider />
                {profileExtra(close)}
              </>
            )}
          </ProfileBox>
          {groups.map((group, index) => (
            <Fragment key={index}>
              {index > 0 && <Separator />}
              {group.map((item) =>
                item.href ? (
                  <ItemLink
                    key={item.label}
                    href={item.href}
                    $tone={item.tone}
                    onClick={close}
                  >
                    {item.icon}
                    {item.label}
                  </ItemLink>
                ) : (
                  <ItemButton
                    key={item.label}
                    type="button"
                    $tone={item.tone}
                    onClick={() => {
                      close();
                      item.onSelect?.();
                    }}
                  >
                    {item.icon}
                    {item.label}
                  </ItemButton>
                ),
              )}
            </Fragment>
          ))}
        </Panel>
      )}
    >
      <Trigger type="button" aria-label={`Account: ${name}`}>
        <Avatar>
          <AvatarContent url={avatarUrl} size={40} placeholder={placeholder} />
        </Avatar>
        <Text $faded={collapsed}>
          <Name>{name}</Name>
        </Text>
      </Trigger>
    </Popover>
  );
}
