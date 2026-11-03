import { StyledLink } from 'baseui/link';
import { Link as AppLink, type LinkProps } from '../navigation';

export type { LinkProps };

export function Link(props: LinkProps) {
  return <StyledLink $as={AppLink} {...props} />;
}
