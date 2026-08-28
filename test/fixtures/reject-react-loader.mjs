export function resolve(specifier, context, nextResolve) {
  if (/^react(?:\/|$)|^react-dom(?:\/|$)/u.test(specifier)) {
    throw new Error(`Unexpected React dependency in headless entry: ${specifier}`);
  }

  return nextResolve(specifier, context);
}
