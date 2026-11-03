import logoOnLight from '../../../../brand/svg/nextbase-logo-dark.svg';
import logoOnDark from '../../../../brand/svg/nextbase-logo-light.svg';
import markOnLight from '../../../../brand/svg/nextbase-mark-dark.svg';
import markOnDark from '../../../../brand/svg/nextbase-mark-light.svg';
import { useColorMode } from '../ui/provider/index.ts';
import { styled } from '../ui/styles/index.ts';
import { VisuallyHidden } from '../ui/visually-hidden/index.ts';

const Logo = styled('span', {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: '40px',
  height: '40px',
});

export function Brand() {
  const { dark } = useColorMode();
  return (
    <Logo>
      <img
        src={dark ? markOnDark : markOnLight}
        alt=""
        width={28}
        height={28}
      />
      <VisuallyHidden>NextBase</VisuallyHidden>
    </Logo>
  );
}

export function BrandLogo() {
  const { dark } = useColorMode();
  return (
    <img
      src={dark ? logoOnDark : logoOnLight}
      alt="NextBase"
      width={155}
      height={32}
    />
  );
}
