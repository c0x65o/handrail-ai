import {
  parseToolDefinition,
  type JsonObject,
  type JsonSchemaObject,
  type JsonValue,
  type ToolDefinition,
} from "../protocol.js";

export type ToolDiscoverPredicate<TContext> = (context: TContext) => boolean;

/**
 * Application-owned tool data. Only `definition` is included in public catalogs;
 * the executor and discovery policy remain local to the registry.
 */
export interface ToolRegistration<TExecutor = unknown, TContext = unknown> {
  readonly definition: ToolDefinition;
  readonly executor: TExecutor;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly discover?: ToolDiscoverPredicate<TContext>;
}

export interface ToolDiscoveryQuery<TContext = unknown> {
  readonly context: TContext;
  /** Capabilities available to the current caller or runtime. */
  readonly capabilities?: readonly string[];
  /** When present, a tool must have every requested tag. */
  readonly tags?: readonly string[];
}

export type ToolRegistrationSource<TExecutor, TContext> =
  | Iterable<ToolRegistration<TExecutor, TContext>>
  | AsyncIterable<ToolRegistration<TExecutor, TContext>>;

/** Provider-neutral seam for applications and connectors that supply tools. */
export interface ToolDiscoveryAdapter<
  TExecutor = unknown,
  TContext = unknown,
  TAdapterContext = unknown,
> {
  registrations(
    context: TAdapterContext,
  ):
    | ToolRegistrationSource<TExecutor, TContext>
    | Promise<ToolRegistrationSource<TExecutor, TContext>>;
}

function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJson);

  const clone: JsonObject = {};
  for (const [key, item] of Object.entries(value)) clone[key] = cloneJson(item);
  return clone;
}

function freezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      value.forEach(freezeJson);
    } else {
      Object.values(value).forEach(freezeJson);
    }
    Object.freeze(value);
  }
  return value;
}

function immutableDefinition(definition: ToolDefinition): ToolDefinition {
  const inputSchema = cloneJson(definition.input_schema) as JsonSchemaObject;
  freezeJson(inputSchema);
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    input_schema: inputSchema,
  });
}

function normalizedStrings(
  values: readonly string[] | undefined,
  field: "tags" | "capabilities",
): readonly string[] | undefined {
  if (values === undefined) return undefined;

  const seen = new Set<string>();
  const normalized = values.map((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${field}[${index}] must be a non-empty string`);
    }
    if (seen.has(value)) throw new TypeError(`${field}[${index}] must be unique`);
    seen.add(value);
    return value;
  });
  return Object.freeze(normalized);
}

function immutableRegistration<TExecutor, TContext>(
  registration: ToolRegistration<TExecutor, TContext>,
): ToolRegistration<TExecutor, TContext> {
  const definition = immutableDefinition(parseToolDefinition(registration.definition));
  const tags = normalizedStrings(registration.tags, "tags");
  const capabilities = normalizedStrings(registration.capabilities, "capabilities");
  const snapshot = { definition } as ToolRegistration<TExecutor, TContext>;

  Object.defineProperties(snapshot, {
    executor: {
      configurable: false,
      enumerable: false,
      value: registration.executor,
      writable: false,
    },
    ...(tags === undefined
      ? {}
      : { tags: { configurable: false, enumerable: true, value: tags, writable: false } }),
    ...(capabilities === undefined
      ? {}
      : {
          capabilities: {
            configurable: false,
            enumerable: true,
            value: capabilities,
            writable: false,
          },
        }),
    ...(registration.discover === undefined
      ? {}
      : {
          discover: {
            configurable: false,
            enumerable: false,
            value: registration.discover,
            writable: false,
          },
        }),
  });

  return Object.freeze(snapshot);
}

function includesAll(available: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.every((value) => available.has(value));
}

export class ToolRegistry<TExecutor = unknown, TContext = unknown> {
  readonly #registrations = new Map<string, ToolRegistration<TExecutor, TContext>>();

  register(registration: ToolRegistration<TExecutor, TContext>): this {
    const snapshot = immutableRegistration(registration);
    const name = snapshot.definition.name;
    if (this.#registrations.has(name)) {
      throw new TypeError(`Tool "${name}" is already registered`);
    }
    this.#registrations.set(name, snapshot);
    return this;
  }

  unregister(name: string): boolean {
    return this.#registrations.delete(name);
  }

  get(name: string): ToolRegistration<TExecutor, TContext> | undefined {
    return this.#registrations.get(name);
  }

  list(): readonly ToolDefinition[] {
    return Object.freeze(
      [...this.#registrations.values()]
        .sort((left, right) => left.definition.name.localeCompare(right.definition.name))
        .map((registration) => registration.definition),
    );
  }

  discover(query: ToolDiscoveryQuery<TContext>): readonly ToolDefinition[] {
    const capabilities = new Set(query.capabilities ?? []);
    const tags = new Set(query.tags ?? []);

    return Object.freeze(
      [...this.#registrations.values()]
        .filter((registration) => {
          if (
            registration.capabilities !== undefined &&
            !includesAll(capabilities, registration.capabilities)
          ) {
            return false;
          }
          if (query.tags !== undefined && !includesAll(new Set(registration.tags ?? []), query.tags)) {
            return false;
          }
          return registration.discover?.(query.context) ?? true;
        })
        .sort((left, right) => left.definition.name.localeCompare(right.definition.name))
        .map((registration) => registration.definition),
    );
  }

  /** Atomically add registrations supplied by an application or connector adapter. */
  async registerAdapter<TAdapterContext>(
    adapter: ToolDiscoveryAdapter<TExecutor, TContext, TAdapterContext>,
    context: TAdapterContext,
  ): Promise<void> {
    const source = await adapter.registrations(context);
    const snapshots: ToolRegistration<TExecutor, TContext>[] = [];
    for await (const registration of source) snapshots.push(immutableRegistration(registration));

    const names = new Set<string>();
    for (const snapshot of snapshots) {
      const name = snapshot.definition.name;
      if (names.has(name) || this.#registrations.has(name)) {
        throw new TypeError(`Tool "${name}" is already registered`);
      }
      names.add(name);
    }

    snapshots.forEach((snapshot) => this.#registrations.set(snapshot.definition.name, snapshot));
  }
}
