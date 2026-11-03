// baseui's MaskedInput is not exported: it relies on react-input-mask 2.x, which
// calls ReactDOM.findDOMNode, removed in React 19.

export type { InputProps, StatefulInputProps } from './input';
export { Input, StatefulInput } from './input';
