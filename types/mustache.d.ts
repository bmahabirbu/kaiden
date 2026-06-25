declare module 'mustache' {
  export function render(template: string, view: object): string;

  const Mustache: {
    render: typeof render;
  };

  export default Mustache;
}
