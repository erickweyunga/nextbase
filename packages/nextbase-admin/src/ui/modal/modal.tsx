import { styled, type Theme } from 'baseui';
import { KIND, SHAPE, SIZE } from 'baseui/button';
import { LocaleContext } from 'baseui/locale';
import {
  SIZE as BASE_MODAL_SIZE,
  Modal as BaseModal,
  ModalButton as BaseModalButton,
  ModalBody,
} from 'baseui/modal';
import { type ReactNode, useContext, useId } from 'react';
import { Button } from '../button/button';
import { COMPACT_CONTROL_HEIGHT } from '../control-height';
import { ArrowBackIcon, CloseIcon } from '../icons/index.tsx';
import type { PropsOf } from '../props-of';

const Header = styled('div', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale600,
  paddingBlockStart: $theme.sizing.scale700,
  paddingBlockEnd: $theme.sizing.scale600,
  paddingInline: $theme.sizing.scale800,
}));

const Media = styled('div', {
  display: 'flex',
  flexShrink: 0,
});

const Heading = styled('div', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale0,
  flexGrow: 1,
  minWidth: 0,
}));

// The close button lives in the title's row so it lines up with the title,
// whatever media or subtitle sit around it.
const TitleRow = styled('div', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale600,
}));

const Title = styled('h2', ({ $theme }) => ({
  ...$theme.typography.font450,
  flexGrow: 1,
  margin: 0,
  color: $theme.colors.contentPrimary,
}));

const Subtitle = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  margin: 0,
  color: $theme.colors.contentTertiary,
}));

// The 36px button is pulled in so it does not make the row taller than the
// title's 24px line, and out by half its padding so the icon, not the hover
// circle, lines up with the header's inline padding.
const CloseSlot = styled('div', ({ $theme }) => ({
  flexShrink: 0,
  marginBlock: `-${$theme.sizing.scale200}`,
  marginInlineEnd: `-${$theme.sizing.scale300}`,
}));

// A screen's back button and an empty cell of the same width either side of the title, so it stays centred.
const ScreenHeader = styled('div', ({ $theme }) => ({
  display: 'grid',
  gridTemplateColumns: `${COMPACT_CONTROL_HEIGHT} minmax(0, 1fr) ${COMPACT_CONTROL_HEIGHT}`,
  alignItems: 'center',
  columnGap: $theme.sizing.scale600,
  paddingBlockStart: $theme.sizing.scale600,
  paddingBlockEnd: $theme.sizing.scale600,
  paddingInline: $theme.sizing.scale600,
}));

const ScreenTitle = styled('h2', ({ $theme }) => ({
  ...$theme.typography.HeadingMedium,
  margin: 0,
  textAlign: 'center',
  color: $theme.colors.contentPrimary,
}));

const ScreenSubtitle = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphMedium,
  gridColumn: '2',
  margin: 0,
  textAlign: 'center',
  color: $theme.colors.contentTertiary,
}));

const MODAL_WIDTHS = {
  sm: 400,
  md: 600,
  lg: 800,
  xl: 1024,
  full: BASE_MODAL_SIZE.full,
} as const;

export type ModalSize = keyof typeof MODAL_WIDTHS;

// baseui's close button is absolutely positioned in the dialog corner; the
// header renders its own so it sits in line with the title.
function NoCloseButton() {
  return null;
}

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Secondary line under the title; also describes the dialog to assistive technology. */
  subtitle?: ReactNode;
  /** Decorative visual before the title, e.g. an avatar. Hidden from assistive technology. */
  media?: ReactNode;
  /** Maximum width: sm 400px, md 600px, lg 800px, xl 1024px, full the whole viewport. Narrower screens shrink it. */
  size?: ModalSize;
  /** False keeps it open on a click outside, for forms whose input a stray click would lose. */
  closeOnBackdrop?: boolean;
  /**
   * "dialog": the title at the start and a close button at the end. "screen", for full-size screens: a back
   * button at the start and the title centred. Media isn't shown on a screen.
   */
  variant?: 'dialog' | 'screen';
  children: ReactNode;
}

/** baseui's Modal with a title row, labelled by its title for assistive technology. */
export function Modal({
  isOpen,
  onClose,
  title,
  subtitle,
  media,
  size = 'md',
  closeOnBackdrop = true,
  variant = 'dialog',
  children,
}: ModalProps) {
  const titleId = useId();
  const subtitleId = useId();
  const locale = useContext(LocaleContext);

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={({ closeSource }) => {
        if (closeOnBackdrop || closeSource !== 'backdrop') onClose();
      }}
      size={MODAL_WIDTHS[size]}
      overrides={{
        Dialog: {
          props: {
            'aria-label': undefined,
            'aria-labelledby': titleId,
            'aria-describedby': subtitle ? subtitleId : undefined,
          },
        },
        Close: { component: NoCloseButton },
        // A full-size modal is a screen of its own: edge to edge, with no frame around it.
        ...(size === 'full' && {
          DialogContainer: { style: { alignItems: 'stretch' } },
          Dialog: {
            style: { margin: 0, borderRadius: 0, minHeight: '100dvh' },
          },
        }),
      }}
    >
      {variant === 'screen' ? (
        <ScreenHeader>
          <Button
            kind={KIND.tertiary}
            shape={SHAPE.circle}
            aria-label="Back"
            onClick={onClose}
          >
            <ArrowBackIcon size={24} aria-hidden />
          </Button>
          <ScreenTitle id={titleId}>{title}</ScreenTitle>
          <span aria-hidden />
          {subtitle && (
            <ScreenSubtitle id={subtitleId}>{subtitle}</ScreenSubtitle>
          )}
        </ScreenHeader>
      ) : (
        <Header>
          {media && <Media aria-hidden>{media}</Media>}
          <Heading>
            <TitleRow>
              <Title id={titleId}>{title}</Title>
              <CloseSlot>
                <Button
                  kind={KIND.tertiary}
                  shape={SHAPE.circle}
                  aria-label={locale.modal.close}
                  onClick={onClose}
                >
                  <CloseIcon size={20} aria-hidden />
                </Button>
              </CloseSlot>
            </TitleRow>
            {subtitle && <Subtitle id={subtitleId}>{subtitle}</Subtitle>}
          </Heading>
        </Header>
      )}
      {children}
    </BaseModal>
  );
}

export type ModalButtonProps = PropsOf<typeof BaseModalButton>;

/** baseui's ModalButton, compact by default. */
export function ModalButton({
  size = SIZE.compact,
  ...props
}: ModalButtonProps) {
  return <BaseModalButton size={size} {...props} />;
}

const ConfirmActions = styled('div', ({ $theme }) => ({
  display: 'flex',
  gap: $theme.sizing.scale300,
}));

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  /** What happens if they confirm, and whether it can be undone. */
  subtitle?: ReactNode;
  /** The confirming button's label, naming the action, e.g. "Remove" or "Withdraw". */
  confirmLabel: string;
  /** The declining button's label. */
  cancelLabel?: string | undefined;
  onConfirm: () => void;
  /** While the action runs: the confirm button spins and both buttons wait. */
  isLoading?: boolean;
  /** For an action that destroys something, such as Delete: the confirm button is red. */
  danger?: boolean;
}

const DANGER_OVERRIDES = {
  BaseButton: {
    style: ({ $theme }: { $theme: Theme }) => ({
      backgroundColor: $theme.colors.backgroundNegative,
      color: $theme.colors.contentOnColor,
      ':hover': { backgroundColor: $theme.colors.negative600 },
      ':active': { backgroundColor: $theme.colors.negative700 },
    }),
  },
};

/** Asks before a destructive or hard-to-undo action: Cancel, then the named action. */
export function ConfirmModal({
  isOpen,
  onClose,
  title,
  subtitle,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  isLoading = false,
  danger = false,
}: ConfirmModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size="sm"
    >
      <ModalBody>
        <ConfirmActions>
          <Button kind={KIND.secondary} onClick={onClose} disabled={isLoading}>
            {cancelLabel}
          </Button>
          <Button
            onClick={onConfirm}
            isLoading={isLoading}
            overrides={danger ? DANGER_OVERRIDES : undefined}
          >
            {confirmLabel}
          </Button>
        </ConfirmActions>
      </ModalBody>
    </Modal>
  );
}
