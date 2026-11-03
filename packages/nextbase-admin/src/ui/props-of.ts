import type { ComponentProps, JSX, JSXElementConstructor } from 'react';

/**
 * The props a component accepts in JSX. baseui's exported prop types mark props
 * filled in by `defaultProps` as required; JSX treats them as optional.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches React's own ComponentProps constraint.
export type PropsOf<C extends JSXElementConstructor<any>> =
  JSX.LibraryManagedAttributes<C, ComponentProps<C>>;
