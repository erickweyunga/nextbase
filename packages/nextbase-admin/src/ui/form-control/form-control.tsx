import { styled, withStyle } from 'baseui';
import {
  LabelContainer as BaseLabelContainer,
  LabelEndEnhancer as BaseLabelEndEnhancer,
  Caption,
  CaptionIcon,
  CaptionMessage,
  ControlContainer,
  Label,
} from 'baseui/form-control/styled-components';
import {
  Children,
  cloneElement,
  type ReactElement,
  type ReactNode,
  useId,
} from 'react';
import { CheckIcon, ErrorIcon } from '../icons/index.tsx';

const LabelContainer = withStyle(BaseLabelContainer, ({ $theme }) => ({
  alignItems: 'baseline',
  gap: $theme.sizing.scale600,
}));

// baseui sizes the enhancer at zero flex and full width, so any text in it wraps word by word.
const LabelEndEnhancer = withStyle(BaseLabelEndEnhancer, {
  flex: 'none',
  width: 'auto',
  marginInlineStart: 'auto',
  whiteSpace: 'nowrap',
  lineHeight: 1,
});

// One box for the label and the control, so a FormControl is a single cell in a grid or flex row.
// minWidth 0 lets it shrink there instead of overflowing.
// The space under a control separates it from the next one; the last field in a section or form leaves it to
// the container's own padding.
const Root = styled('div', {
  minWidth: 0,
  ":last-child [data-baseweb='form-control-container']": { marginBottom: 0 },
});

const RequiredMark = styled('span', ({ $theme }) => ({
  marginInlineStart: $theme.sizing.scale100,
  color: $theme.colors.contentNegative,
}));

interface ControlProps {
  id?: string;
  required?: boolean;
  disabled?: boolean;
  error?: boolean;
  positive?: boolean;
  'aria-describedby'?: string;
  'aria-errormessage'?: string;
}

export interface FormControlProps {
  label?: ReactNode;
  caption?: ReactNode;
  /** `true` marks the control invalid; any other node also replaces the caption. */
  error?: ReactNode;
  /** `true` marks the control valid; any other node also replaces the caption. */
  positive?: ReactNode;
  disabled?: boolean;
  labelEndEnhancer?: ReactNode;
  children: ReactElement<ControlProps>;
}

/**
 * Labels a single form control and wires up its caption.
 *
 * Replaces baseui's FormControl, whose react-uid counter produces different ids
 * on the server and the client. Ids here come from React's useId.
 */
export function FormControl({
  label,
  caption,
  error,
  positive,
  disabled = false,
  labelEndEnhancer,
  children,
}: FormControlProps) {
  const id = useId();
  const control = Children.only(children);
  const controlId = control.props.id ?? `${id}control`;
  const captionId = `${id}caption`;

  const styleProps = {
    $disabled: disabled,
    $error: Boolean(error),
    $positive: Boolean(positive),
  };
  const message =
    [error, positive].find((value) => value && value !== true) ?? caption;
  const icon = error ? (
    <ErrorIcon size={14} aria-hidden />
  ) : positive ? (
    <CheckIcon size={14} aria-hidden />
  ) : null;

  return (
    <Root>
      {label && (
        <LabelContainer {...styleProps}>
          <Label
            data-baseweb="form-control-label"
            htmlFor={controlId}
            {...styleProps}
          >
            {label}
            {control.props.required && (
              <RequiredMark aria-hidden>*</RequiredMark>
            )}
          </Label>
          {labelEndEnhancer && (
            <LabelEndEnhancer {...styleProps}>
              {labelEndEnhancer}
            </LabelEndEnhancer>
          )}
        </LabelContainer>
      )}
      <ControlContainer data-baseweb="form-control-container" {...styleProps}>
        {cloneElement(control, {
          id: controlId,
          'aria-describedby': message ? captionId : undefined,
          'aria-errormessage': message && error ? captionId : undefined,
          disabled: control.props.disabled || disabled,
          error: control.props.error ?? (error ? true : undefined),
          positive: control.props.positive ?? (positive ? true : undefined),
        })}
        {message && (
          <Caption
            data-baseweb="form-control-caption"
            id={captionId}
            {...styleProps}
          >
            {icon && <CaptionIcon>{icon}</CaptionIcon>}
            <CaptionMessage>{message}</CaptionMessage>
          </Caption>
        )}
      </ControlContainer>
    </Root>
  );
}
