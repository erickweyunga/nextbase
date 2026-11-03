import {
  BaseProvider,
  createDarkTheme,
  createLightTheme,
  LightTheme,
  type Theme,
} from 'baseui';
import { PLACEMENT, ToasterContainer } from 'baseui/toast';
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { ConfirmProvider } from '../modal/confirm';
import { SCROLLBAR_COLOR, SCROLLBAR_COLOR_DARK } from '../scrollbar';
import { StyletronRegistry } from '../styletron-registry';

/**
 * The admin provides its sans-serif font as `--font-sans` (see src/main.tsx);
 * system fonts cover the moment before it loads, or an app that sets none.
 */
const SANS_FONT_FAMILY =
  'var(--font-sans), system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif';

// Google Sans reads heavier than baseui's UberMove at the same weight.
const FONT_WEIGHTS: Record<string, number> = { '500': 450, '700': 600 };

type Typography = typeof LightTheme.typography;

// Monospace styles keep baseui's mono stack and weights.
const typography: Partial<
  Record<
    keyof Typography,
    {
      fontFamily: string;
      fontWeight: Typography[keyof Typography]['fontWeight'];
    }
  >
> = Object.fromEntries(
  Object.entries(LightTheme.typography)
    .filter(([, style]) => !style.fontFamily.includes('Mono'))
    .map(([name, style]) => [
      name,
      {
        fontFamily: SANS_FONT_FAMILY,
        fontWeight: FONT_WEIGHTS[String(style.fontWeight)] ?? style.fontWeight,
      },
    ]),
);

// Brand: Electric Blue, applied through baseui's colour layers (baseweb.design/guides/colors).
// Foundation colours regenerate their semantic tokens: `primaryA` #172554 is the
// primary-button, selection and link colour, while text stays black (TEXT below);
// `accent` #2563EB is the brand (white text on it is 5.2:1). baseui
// 18 derives only backgroundAccent from `accent`, so the other accent tokens are set
// explicitly: #DBEAFE tints, #60A5FA light borders. Backgrounds keep baseui's neutral
// greys. Steps between come from the same blue family.
const BRAND = {
  accent: '#2563EB',
  accent50: '#EFF6FF',
  accent100: '#DBEAFE',
  accent200: '#BFDBFE',
  accent300: '#93C5FD',
  accent400: '#60A5FA',
  accent500: '#3B82F6',
  accent600: '#2563EB',
  accent700: '#172554',
};

const TEXT = '#000000';

const lightTheme = createLightTheme({
  typography,
  colors: {
    primaryA: '#172554',
    ...BRAND,
    contentPrimary: TEXT,
    menuFontDefault: TEXT,
    menuFontHighlighted: TEXT,
    menuFontSelected: TEXT,
    buttonSecondaryText: TEXT,
    buttonTertiaryText: TEXT,
    breadcrumbsText: TEXT,
    inputEnhancerFill: TEXT,
    tableFilterHeading: TEXT,
    calendarForeground: TEXT,
    backgroundAccent: BRAND.accent600,
    backgroundAccentLight: BRAND.accent100,
    contentAccent: BRAND.accent600,
    borderAccent: BRAND.accent600,
    borderAccentLight: BRAND.accent400,
  },
});

const darkTheme = createDarkTheme({
  typography,
  colors: {
    ...BRAND,
    backgroundAccent: BRAND.accent600,
    backgroundAccentLight: BRAND.accent700,
    contentAccent: BRAND.accent400,
    borderAccent: BRAND.accent500,
    borderAccentLight: '#1E3A8A',
  },
});

export type ColorMode = 'system' | 'light' | 'dark';

const COLOR_MODE_KEY = 'nextbase-admin-color-mode';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function storedColorMode(): ColorMode {
  try {
    const mode = localStorage.getItem(COLOR_MODE_KEY);
    return mode === 'light' || mode === 'dark' ? mode : 'system';
  } catch {
    return 'system';
  }
}

function subscribeToSystem(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const systemPrefersDark = () => window.matchMedia(DARK_QUERY).matches;

interface ColorModeState {
  mode: ColorMode;
  dark: boolean;
  setMode: (mode: ColorMode) => void;
}

const ColorModeContext = createContext<ColorModeState>({
  mode: 'system',
  dark: false,
  setMode: () => {},
});

export function useColorMode(): ColorModeState {
  return useContext(ColorModeContext);
}

// baseui's layers (modals, drawers, menus, tooltips) otherwise have no z-index,
// so positioned page content such as a sticky header paints over them.
const LAYERS_Z_INDEX = 100;

// Long enough to read a sentence; toasts can also be closed by hand.
const TOAST_DURATION = 6000;

// baseui stretches the close icon to the top corner and fixes the width at 288px:
// centre the icon on the text and let the toast fit its message.
const TOAST_Z_INDEX = 1200;

const TOAST_OVERRIDES = {
  Root: { style: { zIndex: TOAST_Z_INDEX } },
  ToastBody: {
    style: ({
      $theme,
      $isVisible,
    }: {
      $theme: Theme;
      $isVisible: boolean;
    }) => ({
      ...$theme.typography.ParagraphMedium,
      transform: $isVisible ? 'none' : 'translateY(-12px)',
      '@media (prefers-reduced-motion: reduce)': { transform: 'none' },
      alignItems: 'center',
      gap: $theme.sizing.scale500,
      boxSizing: 'border-box',
      width: 'auto',
      minWidth: '280px',
      maxWidth: 'min(400px, calc(100vw - 32px))',
      paddingBlock: $theme.sizing.scale500,
      paddingInline: $theme.sizing.scale600,
    }),
  },
  ToastInnerContainer: { style: { flexGrow: 1 } },
  ToastCloseIcon: { style: { alignSelf: 'center' } },
};

export function UIProvider({ children }: { children: ReactNode }) {
  const [mode, setStoredMode] = useState(storedColorMode);
  const systemDark = useSyncExternalStore(
    subscribeToSystem,
    systemPrefersDark,
    () => false,
  );
  const dark = mode === 'dark' || (mode === 'system' && systemDark);
  const theme = dark ? darkTheme : lightTheme;

  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.colorScheme = dark ? 'dark' : 'light';
    root.scrollbarColor = dark ? SCROLLBAR_COLOR_DARK : SCROLLBAR_COLOR;
    document.body.style.backgroundColor = theme.colors.backgroundPrimary;
  }, [dark, theme]);

  const colorMode = useMemo<ColorModeState>(
    () => ({
      mode,
      dark,
      setMode: (next) => {
        setStoredMode(next);
        try {
          if (next === 'system') localStorage.removeItem(COLOR_MODE_KEY);
          else localStorage.setItem(COLOR_MODE_KEY, next);
        } catch {}
      },
    }),
    [mode, dark],
  );

  return (
    <ColorModeContext.Provider value={colorMode}>
      <StyletronRegistry>
        <BaseProvider theme={theme} zIndex={LAYERS_Z_INDEX}>
          <ToasterContainer
            placement={PLACEMENT.topRight}
            autoHideDuration={TOAST_DURATION}
            overrides={TOAST_OVERRIDES}
            usePortal={false}
          >
            <ConfirmProvider>{children}</ConfirmProvider>
          </ToasterContainer>
        </BaseProvider>
      </StyletronRegistry>
    </ColorModeContext.Provider>
  );
}
