// vendor/openclaw/packages/llm-core/dist/utils/event-stream.mjs
var EventStream = class {
  constructor(isComplete, extractResult) {
    this.queue = [];
    this.waiting = [];
    this.done = false;
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve2) => {
      this.resolveFinalResult = resolve2;
    });
  }
  push(event) {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({
      value: event,
      done: false
    });
    else this.queue.push(event);
  }
  end(result) {
    this.done = true;
    if (result !== void 0) this.resolveFinalResult(result);
    while (this.waiting.length > 0) this.waiting.shift()({
      value: void 0,
      done: true
    });
  }
  async *[Symbol.asyncIterator]() {
    while (true) if (this.queue.length > 0) yield this.queue.shift();
    else if (this.done) return;
    else {
      const result = await new Promise((resolve2) => {
        this.waiting.push(resolve2);
      });
      if (result.done) return;
      yield result.value;
    }
  }
  result() {
    return this.finalResultPromise;
  }
};

// vendor/openclaw/packages/llm-core/dist/validation.mjs
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
var validatorCache = /* @__PURE__ */ new WeakMap();
var TYPEBOX_KIND = /* @__PURE__ */ Symbol.for("TypeBox.Kind");
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isJsonSchemaObject(value) {
  return isRecord(value);
}
function hasTypeBoxMetadata(schema) {
  return isRecord(schema) && Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND);
}
function getSchemaTypes(schema) {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((type) => typeof type === "string");
  return [];
}
function matchesJsonType(value, type) {
  switch (type) {
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value) && !Array.isArray(value);
    default:
      return false;
  }
}
function isValidatorSchema(value) {
  return isRecord(value);
}
var JSON_NUMBER_TOKEN_RE = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[+-]?\d+)?$/iu;
function parseJsonNumberString(value) {
  const trimmed = value.trim();
  if (!trimmed || !JSON_NUMBER_TOKEN_RE.test(trimmed)) return;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function parseJsonIntegerString(value) {
  const parsed = parseJsonNumberString(value);
  return parsed !== void 0 && Number.isSafeInteger(parsed) ? parsed : void 0;
}
function getSubSchemaValidator(schema) {
  if (!isValidatorSchema(schema)) return;
  try {
    return getValidator(schema);
  } catch {
    return;
  }
}
function coercePrimitiveByType(value, type) {
  switch (type) {
    case "number":
      if (value === null) return 0;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = parseJsonNumberString(value);
        if (parsed !== void 0) return parsed;
      }
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    case "integer":
      if (value === null) return 0;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = parseJsonIntegerString(value);
        if (parsed !== void 0) return parsed;
      }
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    case "boolean":
      if (value === null) return false;
      if (typeof value === "string") {
        if (value === "true") return true;
        if (value === "false") return false;
      }
      if (typeof value === "number") {
        if (value === 1) return true;
        if (value === 0) return false;
      }
      return value;
    case "string":
      if (value === null) return "";
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return value;
    case "null":
      if (value === "" || value === 0 || value === false) return null;
      return value;
    default:
      return value;
  }
}
function applySchemaObjectCoercion(value, schema) {
  const properties = schema.properties;
  const definedKeys = new Set(properties ? Object.keys(properties) : []);
  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) if (key in value) value[key] = coerceWithJsonSchema(value[key], propertySchema);
  }
  if (schema.additionalProperties && isJsonSchemaObject(schema.additionalProperties)) {
    for (const [key, propertyValue] of Object.entries(value)) if (!definedKeys.has(key)) value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
  }
}
function applySchemaArrayCoercion(value, schema) {
  if (Array.isArray(schema.items)) {
    for (let index = 0; index < value.length; index++) {
      const itemSchema = schema.items[index];
      if (itemSchema) value[index] = coerceWithJsonSchema(value[index], itemSchema);
    }
    return;
  }
  if (isJsonSchemaObject(schema.items)) for (let index = 0; index < value.length; index++) value[index] = coerceWithJsonSchema(value[index], schema.items);
}
function coerceWithUnionSchema(value, schemas) {
  for (const schema of schemas) {
    const coerced = coerceWithJsonSchema(structuredClone(value), schema);
    if (getSubSchemaValidator(schema)?.Check(coerced)) return coerced;
  }
  return value;
}
function coerceWithJsonSchema(value, schema) {
  let nextValue = value;
  if (Array.isArray(schema.allOf)) for (const nested of schema.allOf) nextValue = coerceWithJsonSchema(nextValue, nested);
  if (Array.isArray(schema.anyOf)) nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
  if (Array.isArray(schema.oneOf)) nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
  const schemaTypes = getSchemaTypes(schema);
  const matchesUnionMember = schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
  if (schemaTypes.length > 0 && !matchesUnionMember) for (const schemaType of schemaTypes) {
    const candidate = coercePrimitiveByType(nextValue, schemaType);
    if (candidate !== nextValue) {
      nextValue = candidate;
      break;
    }
  }
  if (schemaTypes.includes("object") && isRecord(nextValue) && !Array.isArray(nextValue)) applySchemaObjectCoercion(nextValue, schema);
  if (schemaTypes.includes("array") && Array.isArray(nextValue)) applySchemaArrayCoercion(nextValue, schema);
  return nextValue;
}
function getValidator(schema) {
  const key = schema;
  const cached = validatorCache.get(key);
  if (cached) return cached;
  const validator = Compile(schema);
  validatorCache.set(key, validator);
  return validator;
}
function formatValidationPath(error) {
  if (error.keyword === "required") {
    const requiredProperty = error.params.requiredProperties?.[0];
    if (requiredProperty) {
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  return error.instancePath.replace(/^\//, "").replace(/\//g, ".") || "root";
}
function validateToolCall(tools, toolCall) {
  const tool = tools.find((t) => t.name === toolCall.name);
  if (!tool) throw new Error(`Tool "${toolCall.name}" not found`);
  return validateToolArguments(tool, toolCall);
}
function validateToolArguments(tool, toolCall) {
  const args = structuredClone(toolCall.arguments);
  Value.Convert(tool.parameters, args);
  const validator = getValidator(tool.parameters);
  if (!hasTypeBoxMetadata(tool.parameters) && isJsonSchemaObject(tool.parameters)) {
    const coerced = coerceWithJsonSchema(args, tool.parameters);
    if (coerced !== args) if (isRecord(args) && isRecord(coerced)) {
      for (const key of Object.keys(args)) delete args[key];
      Object.assign(args, coerced);
    } else return validator.Check(coerced) ? coerced : args;
  }
  if (validator.Check(args)) return args;
  const errors = validator.Errors(args).map((error) => `  - ${formatValidationPath(error)}: ${error.message}`).join("\n") || "Unknown validation error";
  throw new Error(`Validation failed for tool "${toolCall.name}":
${errors}

Received arguments:
${JSON.stringify(toolCall.arguments, null, 2)}`);
}

// vendor/openclaw/packages/agent-core/src/runtime-deps.ts
function missingRuntimeDep(name) {
  return new Error(
    `@openclaw/agent-core runtime dependency "${name}" is not configured. Pass an AgentCoreRuntimeDeps instance or a streamFn explicitly.`
  );
}
function resolveAgentCoreStreamFn(runtime, streamFn) {
  if (streamFn) {
    return streamFn;
  }
  if (runtime?.streamSimple) {
    return runtime.streamSimple;
  }
  throw missingRuntimeDep("streamSimple");
}
function resolveAgentCoreCompleteFn(runtime) {
  if (runtime?.completeSimple) {
    return runtime.completeSimple;
  }
  throw missingRuntimeDep("completeSimple");
}

// vendor/openclaw/packages/agent-core/src/agent-loop.ts
var EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
var EventStreamConstructor = EventStream;
function agentLoop(prompts, context, config, signal, streamFn, runtime) {
  const stream = createAgentStream();
  void runAgentLoop(
    prompts,
    context,
    config,
    async (event) => {
      stream.push(event);
    },
    signal,
    streamFn,
    runtime
  ).then((messages) => {
    stream.end(messages);
  }).catch((error) => {
    pushLoopFailure(stream, config, error, signal?.aborted === true);
  });
  return stream;
}
function agentLoopContinue(context, config, signal, streamFn, runtime) {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }
  const stream = createAgentStream();
  void runAgentLoopContinue(
    context,
    config,
    async (event) => {
      stream.push(event);
    },
    signal,
    streamFn,
    runtime
  ).then((messages) => {
    stream.end(messages);
  }).catch((error) => {
    pushLoopFailure(stream, config, error, signal?.aborted === true);
  });
  return stream;
}
async function runAgentLoop(prompts, context, config, emit, signal, streamFn, runtime) {
  const newMessages = [...prompts];
  const currentContext = {
    ...context,
    messages: [...context.messages, ...prompts]
  };
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }
  await runLoop(currentContext, newMessages, config, signal, emit, streamFn, runtime);
  return newMessages;
}
async function runAgentLoopContinue(context, config, emit, signal, streamFn, runtime) {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }
  const newMessages = [];
  const currentContext = { ...context };
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await runLoop(currentContext, newMessages, config, signal, emit, streamFn, runtime);
  return newMessages;
}
function createAgentStream() {
  return new EventStreamConstructor(
    (event) => event.type === "agent_end",
    (event) => event.type === "agent_end" ? event.messages : []
  );
}
function createLoopFailureMessage(config, error, aborted) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: config.model.api,
    provider: config.model.provider,
    model: config.model.id,
    usage: EMPTY_USAGE,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now()
  };
}
function pushLoopFailure(stream, config, error, aborted) {
  const failureMessage = createLoopFailureMessage(config, error, aborted);
  stream.push({ type: "message_start", message: failureMessage });
  stream.push({ type: "message_end", message: failureMessage });
  stream.push({ type: "turn_end", message: failureMessage, toolResults: [] });
  stream.push({ type: "agent_end", messages: [failureMessage] });
}
async function runLoop(initialContext, newMessages, initialConfig, signal, emit, streamFn, runtime) {
  let currentContext = initialContext;
  let config = initialConfig;
  let firstTurn = true;
  let pendingMessages = await config.getSteeringMessages?.() || [];
  while (true) {
    let hasMoreToolCalls = true;
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }
      if (pendingMessages.length > 0) {
        for (const message2 of pendingMessages) {
          await emit({ type: "message_start", message: message2 });
          await emit({ type: "message_end", message: message2 });
          currentContext.messages.push(message2);
          newMessages.push(message2);
        }
      }
      const message = await streamAssistantResponse(
        currentContext,
        config,
        signal,
        emit,
        streamFn,
        runtime
      );
      newMessages.push(message);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }
      const toolCalls = message.content.filter((c) => c.type === "toolCall");
      const toolResults = [];
      hasMoreToolCalls = false;
      if (toolCalls.length > 0) {
        const executedToolBatch = await executeToolCalls(
          currentContext,
          message,
          config,
          signal,
          emit
        );
        toolResults.push(...executedToolBatch.messages);
        hasMoreToolCalls = !executedToolBatch.terminate;
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }
      await emit({ type: "turn_end", message, toolResults });
      const nextTurnContext = {
        message,
        toolResults,
        context: currentContext,
        newMessages
      };
      const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
      if (nextTurnSnapshot) {
        currentContext = nextTurnSnapshot.context ?? currentContext;
        config = Object.assign({}, config, {
          model: nextTurnSnapshot.model ?? config.model,
          reasoning: nextTurnSnapshot.thinkingLevel === void 0 ? config.reasoning : nextTurnSnapshot.thinkingLevel === "off" ? void 0 : nextTurnSnapshot.thinkingLevel
        });
      }
      if (await config.shouldStopAfterTurn?.({
        message,
        toolResults,
        context: currentContext,
        newMessages
      })) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }
      pendingMessages = await config.getSteeringMessages?.() || [];
    }
    const followUpMessages = await config.getFollowUpMessages?.() || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }
    break;
  }
  await emit({ type: "agent_end", messages: newMessages });
}
async function streamAssistantResponse(context, config, signal, emit, streamFn, runtime) {
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }
  const llmMessages = await config.convertToLlm(messages);
  const llmContext = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools
  };
  const streamFunction = resolveAgentCoreStreamFn(runtime, streamFn);
  const resolvedApiKey = (config.getApiKey ? await config.getApiKey(config.model.provider) : void 0) || config.apiKey;
  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal
  });
  let partialMessage = null;
  let addedPartial = false;
  for await (const event of response) {
    switch (event.type) {
      case "start": {
        const message = event.partial;
        partialMessage = message;
        context.messages.push(message);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...message } });
        break;
      }
      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          const message = event.partial;
          partialMessage = message;
          context.messages[context.messages.length - 1] = message;
          await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...message }
          });
        }
        break;
      case "done":
      case "error": {
        const finalMessage2 = await response.result();
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage2;
        } else {
          context.messages.push(finalMessage2);
        }
        if (!addedPartial) {
          await emit({ type: "message_start", message: { ...finalMessage2 } });
        }
        await emit({ type: "message_end", message: finalMessage2 });
        return finalMessage2;
      }
    }
  }
  const finalMessage = await response.result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: "message_start", message: { ...finalMessage } });
  }
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}
async function executeToolCalls(currentContext, assistantMessage, config, signal, emit) {
  const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
  const hasSequentialToolCall = toolCalls.some(
    (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential"
  );
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(
      currentContext,
      assistantMessage,
      toolCalls,
      config,
      signal,
      emit
    );
  }
  return executeToolCallsParallel(
    currentContext,
    assistantMessage,
    toolCalls,
    config,
    signal,
    emit
  );
}
async function executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit) {
  const finalizedCalls = [];
  const messages = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments
    });
    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal
    );
    let finalized;
    if (preparation.kind === "immediate") {
      finalized = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError
      };
    } else {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      finalized = await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal
      );
    }
    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    finalizedCalls.push(finalized);
    messages.push(toolResultMessage);
    if (signal?.aborted) {
      break;
    }
  }
  return {
    messages,
    terminate: shouldTerminateToolBatch(finalizedCalls)
  };
}
async function executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit) {
  const finalizedCalls = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments
    });
    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal
    );
    if (preparation.kind === "immediate") {
      const finalized = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError
      };
      await emitToolExecutionEnd(finalized, emit);
      finalizedCalls.push(finalized);
      if (signal?.aborted) {
        break;
      }
      continue;
    }
    finalizedCalls.push(async () => {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      const finalized = await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal
      );
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
    if (signal?.aborted) {
      break;
    }
  }
  const orderedFinalizedCalls = await Promise.all(
    finalizedCalls.map((entry) => typeof entry === "function" ? entry() : Promise.resolve(entry))
  );
  const messages = [];
  for (const finalized of orderedFinalizedCalls) {
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }
  return {
    messages,
    terminate: shouldTerminateToolBatch(orderedFinalizedCalls)
  };
}
function shouldTerminateToolBatch(finalizedCalls) {
  return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
function prepareToolCallArguments(tool, toolCall) {
  if (!tool.prepareArguments) {
    return toolCall;
  }
  const preparedArguments = tool.prepareArguments(toolCall.arguments);
  if (preparedArguments === toolCall.arguments) {
    return toolCall;
  }
  return {
    ...toolCall,
    arguments: preparedArguments
  };
}
async function prepareToolCall(currentContext, assistantMessage, toolCall, config, signal) {
  const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true
    };
  }
  try {
    const preparedToolCall = prepareToolCallArguments(tool, toolCall);
    const validatedArgs = validateToolArguments(tool, preparedToolCall);
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args: validatedArgs,
          context: currentContext
        },
        signal
      );
      if (signal?.aborted) {
        return {
          kind: "immediate",
          result: createErrorToolResult("Operation aborted"),
          isError: true
        };
      }
      if (beforeResult?.block) {
        return {
          kind: "immediate",
          result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
          isError: true
        };
      }
    }
    if (signal?.aborted) {
      return {
        kind: "immediate",
        result: createErrorToolResult("Operation aborted"),
        isError: true
      };
    }
    return {
      kind: "prepared",
      toolCall,
      tool,
      args: validatedArgs
    };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true
    };
  }
}
async function executePreparedToolCall(prepared, signal, emit) {
  const updateEvents = [];
  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args,
      signal,
      (partialResult) => {
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              args: prepared.toolCall.arguments,
              partialResult
            })
          )
        );
      }
    );
    await Promise.all(updateEvents);
    return { result, isError: false };
  } catch (error) {
    await Promise.all(updateEvents);
    return {
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true
    };
  }
}
async function finalizeExecutedToolCall(currentContext, assistantMessage, prepared, executed, config, signal) {
  let result = executed.result;
  let isError = executed.isError;
  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context: currentContext
        },
        signal
      );
      if (afterResult) {
        result = {
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }
  return {
    toolCall: prepared.toolCall,
    result,
    isError
  };
}
function createErrorToolResult(message) {
  return {
    content: [{ type: "text", text: message }],
    details: {}
  };
}
async function emitToolExecutionEnd(finalized, emit) {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError
  });
}
function createToolResultMessage(finalized) {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content,
    details: finalized.result.details,
    isError: finalized.isError,
    timestamp: Date.now()
  };
}
async function emitToolResultMessage(toolResultMessage, emit) {
  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
}

// vendor/openclaw/packages/agent-core/src/agent.ts
function defaultConvertToLlm(messages) {
  return messages.filter(
    (message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult"
  );
}
var EMPTY_USAGE2 = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
var DEFAULT_MODEL = {
  id: "unknown",
  name: "unknown",
  api: "unknown",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0
};
function createMutableAgentState(initialState) {
  let tools = initialState?.tools?.slice() ?? [];
  let messages = initialState?.messages?.slice() ?? [];
  return {
    systemPrompt: initialState?.systemPrompt ?? "",
    model: initialState?.model ?? DEFAULT_MODEL,
    thinkingLevel: initialState?.thinkingLevel ?? "off",
    get tools() {
      return tools;
    },
    set tools(nextTools) {
      tools = nextTools.slice();
    },
    get messages() {
      return messages;
    },
    set messages(nextMessages) {
      messages = nextMessages.slice();
    },
    isStreaming: false,
    streamingMessage: void 0,
    pendingToolCalls: /* @__PURE__ */ new Set(),
    errorMessage: void 0
  };
}
var PendingMessageQueue = class {
  messages = [];
  mode;
  constructor(mode) {
    this.mode = mode;
  }
  enqueue(message) {
    this.messages.push(message);
  }
  hasItems() {
    return this.messages.length > 0;
  }
  drain() {
    if (this.mode === "all") {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }
    const first = this.messages[0];
    if (!first) {
      return [];
    }
    this.messages = this.messages.slice(1);
    return [first];
  }
  clear() {
    this.messages = [];
  }
};
var Agent = class {
  mutableState;
  listeners = /* @__PURE__ */ new Set();
  steeringQueue;
  followUpQueue;
  convertToLlm;
  transformContext;
  runtime;
  streamFn;
  getApiKey;
  onPayload;
  onResponse;
  beforeToolCall;
  afterToolCall;
  prepareNextTurn;
  activeRun;
  /** Session identifier forwarded to providers for cache-aware backends. */
  sessionId;
  /** Optional per-level thinking token budgets forwarded to the stream function. */
  thinkingBudgets;
  /** Preferred transport forwarded to the stream function. */
  transport;
  /** Optional cap for provider-requested retry delays. */
  maxRetryDelayMs;
  /** Tool execution strategy for assistant messages that contain multiple tool calls. */
  toolExecution;
  constructor(options = {}) {
    this.mutableState = createMutableAgentState(options.initialState);
    this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = options.transformContext;
    this.runtime = options.runtime;
    this.streamFn = resolveAgentCoreStreamFn(options.runtime, options.streamFn);
    this.getApiKey = options.getApiKey;
    this.onPayload = options.onPayload;
    this.onResponse = options.onResponse;
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.prepareNextTurn = options.prepareNextTurn;
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
    this.sessionId = options.sessionId;
    this.thinkingBudgets = options.thinkingBudgets;
    this.transport = options.transport ?? "auto";
    this.maxRetryDelayMs = options.maxRetryDelayMs;
    this.toolExecution = options.toolExecution ?? "parallel";
  }
  /**
   * Subscribe to agent lifecycle events.
   *
   * Listener promises are awaited in subscription order and are included in
   * the current run's settlement. Listeners also receive the active abort
   * signal for the current run.
   *
   * `agent_end` is the final emitted event for a run, but the agent does not
   * become idle until all awaited listeners for that event have settled.
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /**
   * Current agent state.
   *
   * Assigning `state.tools` or `state.messages` copies the provided top-level array.
   */
  get state() {
    return this.mutableState;
  }
  /** Controls how queued steering messages are drained. */
  set steeringMode(mode) {
    this.steeringQueue.mode = mode;
  }
  get steeringMode() {
    return this.steeringQueue.mode;
  }
  /** Controls how queued follow-up messages are drained. */
  set followUpMode(mode) {
    this.followUpQueue.mode = mode;
  }
  get followUpMode() {
    return this.followUpQueue.mode;
  }
  /** Queue a message to be injected after the current assistant turn finishes. */
  steer(message) {
    this.steeringQueue.enqueue(message);
  }
  /** Queue a message to run only after the agent would otherwise stop. */
  followUp(message) {
    this.followUpQueue.enqueue(message);
  }
  /** Remove all queued steering messages. */
  clearSteeringQueue() {
    this.steeringQueue.clear();
  }
  /** Remove all queued follow-up messages. */
  clearFollowUpQueue() {
    this.followUpQueue.clear();
  }
  /** Remove all queued steering and follow-up messages. */
  clearAllQueues() {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }
  /** Returns true when either queue still contains pending messages. */
  hasQueuedMessages() {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }
  /** Active abort signal for the current run, if any. */
  get signal() {
    return this.activeRun?.abortController.signal;
  }
  /** Abort the current run, if one is active. */
  abort() {
    this.activeRun?.abortController.abort();
  }
  /**
   * Resolve when the current run and all awaited event listeners have finished.
   *
   * This resolves after `agent_end` listeners settle.
   */
  waitForIdle() {
    return this.activeRun?.promise ?? Promise.resolve();
  }
  /** Clear transcript state, runtime state, and queued messages. */
  reset() {
    this.mutableState.messages = [];
    this.mutableState.isStreaming = false;
    this.mutableState.streamingMessage = void 0;
    this.mutableState.pendingToolCalls = /* @__PURE__ */ new Set();
    this.mutableState.errorMessage = void 0;
    this.clearFollowUpQueue();
    this.clearSteeringQueue();
  }
  async prompt(input, images) {
    if (this.activeRun) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion."
      );
    }
    const messages = this.normalizePromptInput(input, images);
    await this.runPromptMessages(messages);
  }
  /** Continue from the current transcript. The last message must be a user or tool-result message. */
  async continue() {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }
    const lastMessage = this.mutableState.messages[this.mutableState.messages.length - 1];
    if (!lastMessage) {
      throw new Error("No messages to continue from");
    }
    if (lastMessage.role === "assistant") {
      const queuedSteering = this.steeringQueue.drain();
      if (queuedSteering.length > 0) {
        await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }
      const queuedFollowUps = this.followUpQueue.drain();
      if (queuedFollowUps.length > 0) {
        await this.runPromptMessages(queuedFollowUps);
        return;
      }
      throw new Error("Cannot continue from message role: assistant");
    }
    await this.runContinuation();
  }
  normalizePromptInput(input, images) {
    if (Array.isArray(input)) {
      return input;
    }
    if (typeof input !== "string") {
      return [input];
    }
    const content = [{ type: "text", text: input }];
    if (images && images.length > 0) {
      content.push(...images);
    }
    return [{ role: "user", content, timestamp: Date.now() }];
  }
  async runPromptMessages(messages, options = {}) {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,
        this.createContextSnapshot(),
        this.createLoopConfig(options),
        (event) => this.processEvents(event),
        signal,
        this.streamFn
      );
    });
  }
  async runContinuation() {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(
        this.createContextSnapshot(),
        this.createLoopConfig(),
        (event) => this.processEvents(event),
        signal,
        this.streamFn
      );
    });
  }
  createContextSnapshot() {
    return {
      systemPrompt: this.mutableState.systemPrompt,
      messages: this.mutableState.messages.slice(),
      tools: this.mutableState.tools.slice()
    };
  }
  createLoopConfig(options = {}) {
    let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
    return {
      model: this.mutableState.model,
      reasoning: this.mutableState.thinkingLevel === "off" ? void 0 : this.mutableState.thinkingLevel,
      sessionId: this.sessionId,
      onPayload: this.onPayload,
      onResponse: this.onResponse,
      transport: this.transport,
      thinkingBudgets: this.thinkingBudgets,
      maxRetryDelayMs: this.maxRetryDelayMs,
      toolExecution: this.toolExecution,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
      prepareNextTurn: this.prepareNextTurn ? async () => await this.prepareNextTurn?.(this.signal) : void 0,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: this.getApiKey,
      getSteeringMessages: async () => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this.steeringQueue.drain();
      },
      getFollowUpMessages: async () => this.followUpQueue.drain()
    };
  }
  async runWithLifecycle(executor) {
    if (this.activeRun) {
      throw new Error("Agent is already processing.");
    }
    const abortController = new AbortController();
    let resolvePromise = () => {
    };
    const promise = new Promise((resolve2) => {
      resolvePromise = resolve2;
    });
    this.activeRun = { promise, resolve: resolvePromise, abortController };
    this.mutableState.isStreaming = true;
    this.mutableState.streamingMessage = void 0;
    this.mutableState.errorMessage = void 0;
    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }
  async handleRunFailure(error, aborted) {
    const failureMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: this.mutableState.model.api,
      provider: this.mutableState.model.provider,
      model: this.mutableState.model.id,
      usage: EMPTY_USAGE2,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now()
    };
    await this.processEvents({ type: "message_start", message: failureMessage });
    await this.processEvents({ type: "message_end", message: failureMessage });
    await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }
  finishRun() {
    this.mutableState.isStreaming = false;
    this.mutableState.streamingMessage = void 0;
    this.mutableState.pendingToolCalls = /* @__PURE__ */ new Set();
    this.activeRun?.resolve();
    this.activeRun = void 0;
  }
  /**
   * Reduce internal state for a loop event, then await listeners.
   *
   * `agent_end` only means no further loop events will be emitted. The run is
   * considered idle later, after all awaited listeners for `agent_end` finish
   * and `finishRun()` clears runtime-owned state.
   */
  async processEvents(event) {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
      case "tool_execution_update":
        break;
      case "message_start":
        this.mutableState.streamingMessage = event.message;
        break;
      case "message_update":
        this.mutableState.streamingMessage = event.message;
        break;
      case "message_end":
        this.mutableState.streamingMessage = void 0;
        this.mutableState.messages.push(event.message);
        break;
      case "tool_execution_start": {
        const pendingToolCalls = new Set(this.mutableState.pendingToolCalls);
        pendingToolCalls.add(event.toolCallId);
        this.mutableState.pendingToolCalls = pendingToolCalls;
        break;
      }
      case "tool_execution_end": {
        const pendingToolCalls = new Set(this.mutableState.pendingToolCalls);
        pendingToolCalls.delete(event.toolCallId);
        this.mutableState.pendingToolCalls = pendingToolCalls;
        break;
      }
      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this.mutableState.errorMessage = event.message.errorMessage;
        }
        break;
      case "agent_end":
        this.mutableState.streamingMessage = void 0;
        break;
    }
    const signal = this.activeRun?.abortController.signal;
    if (!signal) {
      throw new Error("Agent listener invoked outside active run");
    }
    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }
};

// vendor/openclaw/packages/agent-core/src/harness/env/nodejs.ts
import { spawn as spawn2 } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

// vendor/openclaw/packages/agent-core/src/harness/types.ts
function ok(value) {
  return { ok: true, value };
}
function err(error) {
  return { ok: false, error };
}
function getOrThrow(result) {
  if (!result.ok) {
    throw toLintErrorObject(result.error, "Non-Error thrown");
  }
  return result.value;
}
function getOrUndefined(result) {
  return result.ok ? result.value : void 0;
}
function toError(error) {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}
var FileError = class extends Error {
  /** Backend-independent error code. */
  code;
  /** Absolute addressed path associated with the failure, when available. */
  path;
  constructor(code, message, path, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "FileError";
    this.code = code;
    this.path = path;
  }
};
var ExecutionError = class extends Error {
  /** Backend-independent error code. */
  code;
  constructor(code, message, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "ExecutionError";
    this.code = code;
  }
};
var CompactionError = class extends Error {
  /** Backend-independent error code. */
  code;
  constructor(code, message, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "CompactionError";
    this.code = code;
  }
};
var BranchSummaryError = class extends Error {
  /** Backend-independent error code. */
  code;
  constructor(code, message, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "BranchSummaryError";
    this.code = code;
  }
};
var SessionError = class extends Error {
  /** Session subsystem error code. */
  code;
  constructor(code, message, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "SessionError";
    this.code = code;
  }
};
var AgentHarnessError = class extends Error {
  code;
  constructor(code, message, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "AgentHarnessError";
    this.code = code;
  }
};
function toLintErrorObject(value, fallbackMessage) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if (typeof value === "object" && value !== null || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

// vendor/openclaw/packages/agent-core/src/harness/env/kill-tree.ts
import { spawn } from "node:child_process";
var DEFAULT_GRACE_MS = 3e3;
var MAX_GRACE_MS = 6e4;
function killProcessTree(pid, opts) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    if (opts?.force === true) {
      signalProcessTreeWindows(pid, "SIGKILL");
      return;
    }
    const graceMs2 = normalizeGraceMs(opts?.graceMs);
    killProcessTreeWindows(pid, graceMs2);
    return;
  }
  const useGroupKill = opts?.detached !== false;
  if (opts?.force === true) {
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
    return;
  }
  const graceMs = normalizeGraceMs(opts?.graceMs);
  signalProcessTreeUnix(pid, "SIGTERM", useGroupKill);
  setTimeout(() => {
    const stillAlive = useGroupKill ? isProcessAlive(-pid) || isProcessAlive(pid) : isProcessAlive(pid);
    if (!stillAlive) {
      return;
    }
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
  }, graceMs).unref();
}
function signalProcessTree(pid, signal, opts) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    signalProcessTreeWindows(pid, signal);
    return;
  }
  signalProcessTreeUnix(pid, signal, opts?.detached !== false);
}
function normalizeGraceMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GRACE_MS;
  }
  return Math.max(0, Math.min(MAX_GRACE_MS, Math.floor(value)));
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function signalProcessTreeUnix(pid, signal, useGroupKill) {
  if (useGroupKill) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
  }
}
function runTaskkill(args) {
  try {
    spawn("taskkill", args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true
    });
  } catch {
  }
}
function killProcessTreeWindows(pid, graceMs) {
  signalProcessTreeWindows(pid, "SIGTERM");
  setTimeout(() => {
    if (!isProcessAlive(pid)) {
      return;
    }
    signalProcessTreeWindows(pid, "SIGKILL");
  }, graceMs).unref();
}
function signalProcessTreeWindows(pid, signal) {
  const args = signal === "SIGKILL" ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
  runTaskkill(args);
}

// vendor/openclaw/packages/agent-core/src/harness/env/nodejs.ts
var MAX_TIMER_TIMEOUT_MS = 2147e6;
function resolvePath(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
function resolveExecTimeoutMs(timeoutSeconds) {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return void 0;
  }
  const milliseconds = Math.floor(timeoutSeconds * 1e3);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return 1;
  }
  return Math.min(milliseconds, MAX_TIMER_TIMEOUT_MS);
}
function fileKindFromStats(stats) {
  if (stats.isFile()) {
    return "file";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  return void 0;
}
function fileInfoFromStats(path, stats) {
  const kind = fileKindFromStats(stats);
  if (!kind) {
    return err(new FileError("invalid", "Unsupported file type", path));
  }
  return ok({
    name: path.replace(/\/+$/, "").split("/").pop() ?? path,
    path,
    kind,
    size: stats.size,
    mtimeMs: stats.mtimeMs
  });
}
function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
function toFileError(error, path) {
  if (error instanceof FileError) {
    return error;
  }
  const cause = toError(error);
  if (isNodeError(error)) {
    const message = error.message;
    switch (error.code) {
      case "ABORT_ERR":
        return new FileError("aborted", message, path, cause);
      case "ENOENT":
        return new FileError("not_found", message, path, cause);
      case "EACCES":
      case "EPERM":
        return new FileError("permission_denied", message, path, cause);
      case "ENOTDIR":
        return new FileError("not_directory", message, path, cause);
      case "EISDIR":
        return new FileError("is_directory", message, path, cause);
      case "EINVAL":
        return new FileError("invalid", message, path, cause);
      default:
        break;
    }
  }
  return new FileError("unknown", cause.message, path, cause);
}
function abortResult(signal, path) {
  return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : void 0;
}
async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
async function runCommand(command, args, timeoutMs) {
  return await new Promise((resolveLocal) => {
    let stdout = "";
    let child;
    try {
      child = spawn2(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      });
    } catch {
      resolveLocal({ stdout: "", status: null });
      return;
    }
    const timeout = setTimeout(() => {
      if (child.pid) {
        killProcessTree(child.pid, { force: true });
      }
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolveLocal({ stdout: "", status: null });
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolveLocal({ stdout, status });
    });
  });
}
async function findBashOnPath() {
  const result = process.platform === "win32" ? await runCommand("where", ["bash.exe"], 5e3) : await runCommand("which", ["bash"], 5e3);
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
  return firstMatch && await pathExists(firstMatch) ? firstMatch : null;
}
async function getShellConfig(customShellPath) {
  if (customShellPath) {
    if (await pathExists(customShellPath)) {
      return ok({ shell: customShellPath, args: ["-c"] });
    }
    return err(
      new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`)
    );
  }
  if (process.platform === "win32") {
    const candidates = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
    }
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) {
      candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    }
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return ok({ shell: candidate, args: ["-c"] });
      }
    }
    const bashOnPath2 = await findBashOnPath();
    if (bashOnPath2) {
      return ok({ shell: bashOnPath2, args: ["-c"] });
    }
    return err(new ExecutionError("shell_unavailable", "No bash shell found"));
  }
  if (await pathExists("/bin/bash")) {
    return ok({ shell: "/bin/bash", args: ["-c"] });
  }
  const bashOnPath = await findBashOnPath();
  if (bashOnPath) {
    return ok({ shell: bashOnPath, args: ["-c"] });
  }
  return ok({ shell: "sh", args: ["-c"] });
}
function getShellEnv(baseEnv, extraEnv) {
  return {
    ...process.env,
    ...baseEnv,
    ...extraEnv
  };
}
var NodeExecutionEnv = class {
  cwd;
  shellPath;
  shellEnv;
  constructor(options) {
    this.cwd = options.cwd;
    this.shellPath = options.shellPath;
    this.shellEnv = options.shellEnv;
  }
  async absolutePath(path) {
    return ok(resolvePath(this.cwd, path));
  }
  async joinPath(parts) {
    return ok(join(...parts));
  }
  async exec(command, options) {
    if (options?.abortSignal?.aborted) {
      return err(new ExecutionError("aborted", "aborted"));
    }
    const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
    const shellConfig = await getShellConfig(this.shellPath);
    if (!shellConfig.ok) {
      return shellConfig;
    }
    return await new Promise((resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let callbackError;
      let child;
      const timeoutRef = {};
      const onAbort = () => {
        if (child?.pid) {
          killProcessTree(child.pid, { force: true });
        }
      };
      const settle = (result) => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        if (options?.abortSignal) {
          options.abortSignal.removeEventListener("abort", onAbort);
        }
        if (settled) {
          return;
        }
        settled = true;
        resolvePromise(result);
      };
      try {
        child = spawn2(shellConfig.value.shell, [...shellConfig.value.args, command], {
          cwd,
          detached: process.platform !== "win32",
          env: getShellEnv(this.shellEnv, options?.env),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
      } catch (error) {
        const cause = toError(error);
        settle(err(new ExecutionError("spawn_error", cause.message, cause)));
        return;
      }
      const timeoutMs = resolveExecTimeoutMs(options?.timeout);
      timeoutRef.current = timeoutMs === void 0 ? void 0 : setTimeout(() => {
        timedOut = true;
        if (child?.pid) {
          killProcessTree(child.pid, { force: true });
        }
      }, timeoutMs);
      if (options?.abortSignal) {
        if (options.abortSignal.aborted) {
          onAbort();
        } else {
          options.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        try {
          options?.onStdout?.(chunk);
        } catch (error) {
          const cause = toError(error);
          callbackError = new ExecutionError("callback_error", cause.message, cause);
          onAbort();
        }
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
        try {
          options?.onStderr?.(chunk);
        } catch (error) {
          const cause = toError(error);
          callbackError = new ExecutionError("callback_error", cause.message, cause);
          onAbort();
        }
      });
      child.on("error", (error) => {
        settle(err(new ExecutionError("spawn_error", error.message, error)));
      });
      child.on("close", (code) => {
        if (callbackError) {
          settle(err(callbackError));
          return;
        }
        if (timedOut) {
          settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
          return;
        }
        if (options?.abortSignal?.aborted) {
          settle(err(new ExecutionError("aborted", "aborted")));
          return;
        }
        settle(ok({ stdout, stderr, exitCode: code ?? 0 }));
      });
    });
  }
  async readTextFile(path, abortSignal) {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult(abortSignal, resolved);
    if (aborted) {
      return aborted;
    }
    try {
      return ok(await readFile(resolved, { encoding: "utf8", signal: abortSignal }));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async readTextLines(path, options) {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult(options?.abortSignal, resolved);
    if (aborted) {
      return aborted;
    }
    if (options?.maxLines !== void 0 && options.maxLines <= 0) {
      return ok([]);
    }
    let stream;
    let lineReader;
    try {
      stream = createReadStream(resolved, { encoding: "utf8", signal: options?.abortSignal });
      lineReader = createInterface({ input: stream, crlfDelay: Infinity });
      const lines = [];
      for await (const line of lineReader) {
        const loopAbort = abortResult(options?.abortSignal, resolved);
        if (loopAbort) {
          return loopAbort;
        }
        lines.push(line);
        if (options?.maxLines !== void 0 && lines.length >= options.maxLines) {
          break;
        }
      }
      const afterReadAbort = abortResult(options?.abortSignal, resolved);
      if (afterReadAbort) {
        return afterReadAbort;
      }
      return ok(lines);
    } catch (error) {
      return err(toFileError(error, resolved));
    } finally {
      lineReader?.close();
      stream?.destroy();
    }
  }
  async readBinaryFile(path, abortSignal) {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult(abortSignal, resolved);
    if (aborted) {
      return aborted;
    }
    try {
      return ok(await readFile(resolved, { signal: abortSignal }));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async writeFile(path, content, abortSignal) {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult(abortSignal, resolved);
    if (aborted) {
      return aborted;
    }
    try {
      await mkdir(resolve(resolved, ".."), { recursive: true });
      const afterMkdirAbort = abortResult(abortSignal, resolved);
      if (afterMkdirAbort) {
        return afterMkdirAbort;
      }
      await writeFile(resolved, content, { signal: abortSignal });
      return ok(void 0);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async appendFile(path, content) {
    const resolved = resolvePath(this.cwd, path);
    try {
      await mkdir(resolve(resolved, ".."), { recursive: true });
      await appendFile(resolved, content);
      return ok(void 0);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async fileInfo(path) {
    const resolved = resolvePath(this.cwd, path);
    try {
      return fileInfoFromStats(resolved, await lstat(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async listDir(path, abortSignal) {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult(abortSignal, resolved);
    if (aborted) {
      return aborted;
    }
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const infos = [];
      for (const entry of entries) {
        const loopAbort = abortResult(abortSignal, resolved);
        if (loopAbort) {
          return loopAbort;
        }
        const entryPath = resolve(resolved, entry.name);
        try {
          const info = fileInfoFromStats(entryPath, await lstat(entryPath));
          if (info.ok) {
            infos.push(info.value);
          }
        } catch (error) {
          return err(toFileError(error, entryPath));
        }
      }
      return ok(infos);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async canonicalPath(path) {
    const resolved = resolvePath(this.cwd, path);
    try {
      return ok(await realpath(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async exists(path) {
    const result = await this.fileInfo(path);
    if (result.ok) {
      return ok(true);
    }
    if (result.error.code === "not_found") {
      return ok(false);
    }
    return err(result.error);
  }
  async createDir(path, options) {
    const resolved = resolvePath(this.cwd, path);
    try {
      await mkdir(resolved, { recursive: options?.recursive ?? true });
      return ok(void 0);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async remove(path, options) {
    const resolved = resolvePath(this.cwd, path);
    try {
      await rm(resolved, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false
      });
      return ok(void 0);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async createTempDir(prefix = "tmp-") {
    try {
      return ok(await mkdtemp(join(tmpdir(), prefix)));
    } catch (error) {
      return err(toFileError(error));
    }
  }
  async createTempFile(options) {
    const dir = await this.createTempDir("tmp-");
    if (!dir.ok) {
      return dir;
    }
    const filePath = join(
      dir.value,
      `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`
    );
    try {
      await writeFile(filePath, "");
      return ok(filePath);
    } catch (error) {
      return err(toFileError(error, filePath));
    }
  }
  async cleanup() {
  }
};

// vendor/openclaw/packages/agent-core/src/harness/session/timestamps.ts
function parseSessionTimestampMs(value) {
  if (typeof value !== "string" || !value.trim()) {
    return void 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function requireSessionTimestampMs(value, label) {
  const parsed = parseSessionTimestampMs(value);
  if (parsed === void 0) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return parsed;
}

// vendor/openclaw/packages/agent-core/src/harness/messages.ts
function asAgentMessage(message) {
  return message;
}
function normalizeCompactionSummaryTimestamp(timestamp) {
  if (typeof timestamp === "number") {
    return timestamp;
  }
  const parsed = parseSessionTimestampMs(timestamp);
  return parsed ?? 0;
}
var COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
var COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
var BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
var BRANCH_SUMMARY_SUFFIX = `</summary>`;
function bashExecutionToText(msg) {
  let text = `Ran \`${msg.command}\`
`;
  if (msg.output) {
    text += `\`\`\`
${msg.output}
\`\`\``;
  } else {
    text += "(no output)";
  }
  if (msg.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (msg.exitCode !== null && msg.exitCode !== void 0 && msg.exitCode !== 0) {
    text += `

Command exited with code ${msg.exitCode}`;
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `

[Output truncated. Full output: ${msg.fullOutputPath}]`;
  }
  return text;
}
function createBranchSummaryMessage(summary, fromId, timestamp) {
  return {
    role: "branchSummary",
    summary,
    fromId,
    timestamp: requireSessionTimestampMs(timestamp, "branch summary timestamp")
  };
}
function createCompactionSummaryMessage(summary, tokensBefore, timestamp) {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore,
    timestamp: requireSessionTimestampMs(timestamp, "compaction summary timestamp")
  };
}
function createCustomMessage(customType, content, display, details, timestamp) {
  return {
    role: "custom",
    customType,
    content,
    display,
    details,
    timestamp: requireSessionTimestampMs(timestamp, "custom message timestamp")
  };
}
function convertToLlm(messages) {
  return messages.map((m) => {
    const message = m;
    switch (message.role) {
      case "bashExecution":
        if (message.excludeFromContext) {
          return void 0;
        }
        return {
          role: "user",
          content: [{ type: "text", text: bashExecutionToText(message) }],
          timestamp: message.timestamp
        };
      case "custom": {
        const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
        return {
          role: "user",
          content,
          timestamp: message.timestamp
        };
      }
      case "branchSummary":
        return {
          role: "user",
          content: [
            {
              type: "text",
              text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX
            }
          ],
          timestamp: message.timestamp
        };
      case "compactionSummary":
        return {
          role: "user",
          content: [
            {
              type: "text",
              text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX
            }
          ],
          timestamp: normalizeCompactionSummaryTimestamp(message.timestamp)
        };
      case "user":
      case "assistant":
      case "toolResult":
        return message;
      default:
        return void 0;
    }
  }).filter((m) => m !== void 0);
}

// vendor/openclaw/packages/agent-core/src/harness/session/session.ts
function buildSessionContext(pathEntries) {
  let thinkingLevel = "off";
  let model = null;
  let compaction = null;
  for (const entry of pathEntries) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    } else if (entry.type === "compaction") {
      compaction = entry;
    }
  }
  const messages = [];
  const appendMessage = (entry) => {
    if (entry.type === "message") {
      messages.push(entry.message);
    } else if (entry.type === "custom_message") {
      messages.push(
        asAgentMessage(
          createCustomMessage(
            entry.customType,
            entry.content,
            entry.display,
            entry.details,
            entry.timestamp
          )
        )
      );
    } else if (entry.type === "branch_summary" && entry.summary) {
      messages.push(
        asAgentMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp))
      );
    }
  };
  if (compaction) {
    messages.push(
      asAgentMessage(
        createCompactionSummaryMessage(
          compaction.summary,
          compaction.tokensBefore,
          compaction.timestamp
        )
      )
    );
    const compactionIdx = pathEntries.findIndex(
      (e) => e.type === "compaction" && e.id === compaction.id
    );
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = pathEntries[i];
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        appendMessage(entry);
      }
    }
    for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
      appendMessage(pathEntries[i]);
    }
  } else {
    for (const entry of pathEntries) {
      appendMessage(entry);
    }
  }
  return { messages, thinkingLevel, model };
}
var Session = class {
  storage;
  constructor(storage) {
    this.storage = storage;
  }
  getMetadata() {
    return this.storage.getMetadata();
  }
  getStorage() {
    return this.storage;
  }
  getLeafId() {
    return this.storage.getLeafId();
  }
  getEntry(id) {
    return this.storage.getEntry(id);
  }
  getEntries() {
    return this.storage.getEntries();
  }
  async getBranch(fromId) {
    const leafId = fromId ?? await this.storage.getLeafId();
    return this.storage.getPathToRoot(leafId);
  }
  async buildContext() {
    return buildSessionContext(await this.getBranch());
  }
  getLabel(id) {
    return this.storage.getLabel(id);
  }
  async getSessionName() {
    const entries = await this.storage.findEntries("session_info");
    return entries[entries.length - 1]?.name?.trim() || void 0;
  }
  async appendTypedEntry(entry) {
    await this.storage.appendEntry(entry);
    return entry.id;
  }
  async appendMessage(message) {
    return this.appendTypedEntry({
      type: "message",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      message
    });
  }
  async appendThinkingLevelChange(thinkingLevel) {
    return this.appendTypedEntry({
      type: "thinking_level_change",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      thinkingLevel
    });
  }
  async appendModelChange(provider, modelId) {
    return this.appendTypedEntry({
      type: "model_change",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      provider,
      modelId
    });
  }
  async appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook) {
    return this.appendTypedEntry({
      type: "compaction",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook
    });
  }
  /** Append a non-LLM transcript marker for harness-specific state. */
  async appendCustomEntry(customType, data) {
    return this.appendTypedEntry({
      type: "custom",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      customType,
      data
    });
  }
  /** Append harness-specific content that can also be replayed into model context. */
  async appendCustomMessageEntry(customType, content, display, details) {
    return this.appendTypedEntry({
      type: "custom_message",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      customType,
      content,
      display,
      details
    });
  }
  /** Record or clear the display label for an existing session entry. */
  async appendLabel(targetId, label) {
    if (!await this.storage.getEntry(targetId)) {
      throw new SessionError("not_found", `Entry ${targetId} not found`);
    }
    return this.appendTypedEntry({
      type: "label",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      targetId,
      label
    });
  }
  async appendSessionName(name) {
    return this.appendTypedEntry({
      type: "session_info",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      name: name.trim()
    });
  }
  /** Move the visible branch leaf and optionally attach a summary of the abandoned branch. */
  async moveTo(entryId, summary) {
    if (entryId !== null && !await this.storage.getEntry(entryId)) {
      throw new SessionError("not_found", `Entry ${entryId} not found`);
    }
    await this.storage.setLeafId(entryId);
    if (!summary) {
      return void 0;
    }
    return this.appendTypedEntry({
      type: "branch_summary",
      id: await this.storage.createEntryId(),
      parentId: entryId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      fromId: entryId ?? "root",
      summary: summary.summary,
      details: summary.details,
      fromHook: summary.fromHook
    });
  }
};

// vendor/openclaw/packages/agent-core/src/harness/compaction/utils.ts
function createFileOps() {
  return {
    read: /* @__PURE__ */ new Set(),
    written: /* @__PURE__ */ new Set(),
    edited: /* @__PURE__ */ new Set()
  };
}
function extractFileOpsFromMessage(message, fileOps) {
  if (message.role !== "assistant") {
    return;
  }
  if (!("content" in message) || !Array.isArray(message.content)) {
    return;
  }
  for (const block of message.content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    if (!("type" in block) || block.type !== "toolCall") {
      continue;
    }
    if (!("arguments" in block) || !("name" in block)) {
      continue;
    }
    const args = block.arguments;
    if (!args) {
      continue;
    }
    const path = typeof args.path === "string" ? args.path : void 0;
    if (!path) {
      continue;
    }
    switch (block.name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}
function computeFileLists(fileOps) {
  const modified = /* @__PURE__ */ new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles: readOnly, modifiedFiles };
}
function formatFileOperations(readFiles, modifiedFiles) {
  const sections = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>
${readFiles.join("\n")}
</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>
${modifiedFiles.join("\n")}
</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `

${sections.join("\n\n")}`;
}
var TOOL_RESULT_MAX_CHARS = 2e3;
function safeJsonStringify(value) {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}
function truncateForSummary(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}

[... ${truncatedChars} more characters truncated]`;
}
function serializeConversation(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (content) {
        parts.push(`[User]: ${content}`);
      }
    } else if (msg.role === "assistant") {
      const textParts = [];
      const thinkingParts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          thinkingParts.push(block.thinking);
        } else if (block.type === "toolCall") {
          const args = block.arguments;
          const argsStr = Object.entries(args).map(([k, v]) => `${k}=${safeJsonStringify(v)}`).join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (thinkingParts.length > 0) {
        parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    } else if (msg.role === "toolResult") {
      const content = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (content) {
        parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
      }
    }
  }
  return parts.join("\n\n");
}

// vendor/openclaw/packages/agent-core/src/harness/compaction/compaction.ts
function safeJsonStringify2(value) {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}
function extractFileOperations(messages, entries, prevCompactionIndex) {
  const fileOps = createFileOps();
  if (prevCompactionIndex >= 0) {
    const prevCompaction = entries[prevCompactionIndex];
    if (!prevCompaction.fromHook && prevCompaction.details) {
      const details = prevCompaction.details;
      if (Array.isArray(details.readFiles)) {
        for (const f of details.readFiles) {
          fileOps.read.add(f);
        }
      }
      if (Array.isArray(details.modifiedFiles)) {
        for (const f of details.modifiedFiles) {
          fileOps.edited.add(f);
        }
      }
    }
  }
  for (const msg of messages) {
    extractFileOpsFromMessage(msg, fileOps);
  }
  return fileOps;
}
function getMessageFromEntry(entry) {
  if (entry.type === "message") {
    return entry.message;
  }
  if (entry.type === "custom_message") {
    return asAgentMessage(
      createCustomMessage(
        entry.customType,
        entry.content,
        entry.display,
        entry.details,
        entry.timestamp
      )
    );
  }
  if (entry.type === "branch_summary") {
    return asAgentMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
  }
  if (entry.type === "compaction") {
    return asAgentMessage(
      createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)
    );
  }
  return void 0;
}
function getMessageFromEntryForCompaction(entry) {
  if (entry.type === "compaction") {
    return void 0;
  }
  return getMessageFromEntry(entry);
}
var DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 2e4
};
function calculateContextTokens(usage) {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg) {
  if (msg.role === "assistant" && "usage" in msg) {
    const assistantMsg = msg;
    if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
      return assistantMsg.usage;
    }
  }
  return void 0;
}
function getLastAssistantUsage(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const usage = getAssistantUsage(entry.message);
      if (usage) {
        return usage;
      }
    }
  }
  return void 0;
}
function getLastAssistantUsageInfo(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) {
      return { usage, index: i };
    }
  }
  return void 0;
}
function estimateContextTokens(messages) {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null
    };
  }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index
  };
}
function shouldCompact(contextTokens, contextWindow, settings) {
  if (!settings.enabled) {
    return false;
  }
  return contextTokens > contextWindow - settings.reserveTokens;
}
function estimateTokens(message) {
  let chars = 0;
  const harnessMessage = message;
  switch (harnessMessage.role) {
    case "user": {
      const content = harnessMessage.content;
      if (typeof content === "string") {
        chars = content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            chars += block.text.length;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case "assistant": {
      const assistant = harnessMessage;
      for (const block of assistant.content) {
        if (block.type === "text") {
          chars += block.text.length;
        } else if (block.type === "thinking") {
          chars += block.thinking.length;
        } else if (block.type === "toolCall") {
          chars += block.name.length + safeJsonStringify2(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "custom":
    case "toolResult": {
      if (typeof harnessMessage.content === "string") {
        chars = harnessMessage.content.length;
      } else {
        for (const block of harnessMessage.content) {
          if (block.type === "text" && block.text) {
            chars += block.text.length;
          }
          if (block.type === "image") {
            chars += 4800;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case "bashExecution": {
      chars = harnessMessage.command.length + harnessMessage.output.length;
      return Math.ceil(chars / 4);
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = harnessMessage.summary.length;
      return Math.ceil(chars / 4);
    }
  }
  return 0;
}
function findValidCutPoints(entries, startIndex, endIndex) {
  const cutPoints = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    switch (entry.type) {
      case "message": {
        const role = entry.message.role;
        switch (role) {
          case "bashExecution":
          case "custom":
          case "branchSummary":
          case "compactionSummary":
          case "user":
          case "assistant":
            cutPoints.push(i);
            break;
          case "toolResult":
            break;
        }
        break;
      }
      case "thinking_level_change":
      case "model_change":
      case "compaction":
      case "branch_summary":
      case "custom":
      case "custom_message":
      case "label":
      case "session_info":
      case "leaf":
        break;
    }
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}
function findTurnStartIndex(entries, entryIndex, startIndex) {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      return i;
    }
    if (entry.type === "message") {
      const role = entry.message.role;
      if (role === "user" || role === "bashExecution") {
        return i;
      }
    }
  }
  return -1;
}
function findCutPoint(entries, startIndex, endIndex, keepRecentTokens) {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== "message") {
      continue;
    }
    const messageTokens = estimateTokens(entry.message);
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      for (const cutPoint of cutPoints) {
        if (cutPoint >= i) {
          cutIndex = cutPoint;
          break;
        }
      }
      break;
    }
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (prevEntry.type === "compaction") {
      break;
    }
    if (prevEntry.type === "message") {
      break;
    }
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1
  };
}
var SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
var SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
var UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
function createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel) {
  const options = { maxTokens, signal, apiKey, headers };
  if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
    options.reasoning = thinkingLevel;
  }
  return options;
}
async function completeSummarization(model, context, options, streamFn, runtime) {
  if (streamFn) {
    return (await streamFn(model, context, options)).result();
  }
  return await resolveAgentCoreCompleteFn(runtime)(model, context, options);
}
async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, runtime) {
  const maxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY
  );
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}

Additional focus: ${customInstructions}`;
  }
  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);
  let promptText = `<conversation>
${conversationText}
</conversation>

`;
  if (previousSummary) {
    promptText += `<previous-summary>
${previousSummary}
</previous-summary>

`;
  }
  promptText += basePrompt;
  const summarizationMessages = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now()
    }
  ];
  const response = await completeSummarization(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel),
    streamFn,
    runtime
  );
  if (response.stopReason === "aborted") {
    return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
  }
  if (response.stopReason === "error") {
    return err(
      new CompactionError(
        "summarization_failed",
        `Summarization failed: ${response.errorMessage || "Unknown error"}`
      )
    );
  }
  const textContent = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return ok(textContent);
}
function prepareCompaction(pathEntries, settings) {
  if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
    return ok(void 0);
  }
  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }
  let previousSummary;
  let boundaryStart = 0;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex];
    previousSummary = prevCompaction.summary;
    const firstKeptEntryIndex = pathEntries.findIndex(
      (entry) => entry.id === prevCompaction.firstKeptEntryId
    );
    boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
  }
  const boundaryEnd = pathEntries.length;
  const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;
  const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration"
      )
    );
  }
  const firstKeptEntryId = firstKeptEntry.id;
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const msg = getMessageFromEntryForCompaction(pathEntries[i]);
    if (msg) {
      messagesToSummarize.push(msg);
    }
  }
  const turnPrefixMessages = [];
  if (cutPoint.isSplitTurn) {
    for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
      const msg = getMessageFromEntryForCompaction(pathEntries[i]);
      if (msg) {
        turnPrefixMessages.push(msg);
      }
    }
  }
  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  if (cutPoint.isSplitTurn) {
    for (const msg of turnPrefixMessages) {
      extractFileOpsFromMessage(msg, fileOps);
    }
  }
  return ok({
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings
  });
}
var TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;
async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, runtime) {
  const {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings
  } = preparation;
  if (!firstKeptEntryId) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration"
      )
    );
  }
  let summary;
  if (isSplitTurn && turnPrefixMessages.length > 0) {
    const [historyResult, turnPrefixResult] = await Promise.all([
      messagesToSummarize.length > 0 ? generateSummary(
        messagesToSummarize,
        model,
        settings.reserveTokens,
        apiKey,
        headers,
        signal,
        customInstructions,
        previousSummary,
        thinkingLevel,
        streamFn,
        runtime
      ) : Promise.resolve(ok("No prior history.")),
      generateTurnPrefixSummary(
        turnPrefixMessages,
        model,
        settings.reserveTokens,
        apiKey,
        headers,
        signal,
        thinkingLevel,
        streamFn,
        runtime
      )
    ]);
    if (!historyResult.ok) {
      return err(historyResult.error);
    }
    if (!turnPrefixResult.ok) {
      return err(turnPrefixResult.error);
    }
    summary = `${historyResult.value}

---

**Turn Context (split turn):**

${turnPrefixResult.value}`;
  } else {
    const summaryResult = await generateSummary(
      messagesToSummarize,
      model,
      settings.reserveTokens,
      apiKey,
      headers,
      signal,
      customInstructions,
      previousSummary,
      thinkingLevel,
      streamFn,
      runtime
    );
    if (!summaryResult.ok) {
      return err(summaryResult.error);
    }
    summary = summaryResult.value;
  }
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);
  return ok({
    summary,
    firstKeptEntryId,
    tokensBefore,
    details: { readFiles, modifiedFiles }
  });
}
async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, signal, thinkingLevel, streamFn, runtime) {
  const maxTokens = Math.min(
    Math.floor(0.5 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY
  );
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  const promptText = `<conversation>
${conversationText}
</conversation>

${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const summarizationMessages = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now()
    }
  ];
  const response = await completeSummarization(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel),
    streamFn,
    runtime
  );
  if (response.stopReason === "aborted") {
    return err(
      new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted")
    );
  }
  if (response.stopReason === "error") {
    return err(
      new CompactionError(
        "summarization_failed",
        `Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`
      )
    );
  }
  return ok(
    response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
  );
}

// vendor/openclaw/packages/agent-core/src/harness/compaction/branch-summarization.ts
function collectEntriesForBranchSummaryFromBranches(oldBranch, targetBranch) {
  const oldPath = new Set(oldBranch.map((entry) => entry.id));
  let commonAncestorId = null;
  for (let i = targetBranch.length - 1; i >= 0; i--) {
    if (oldPath.has(targetBranch[i].id)) {
      commonAncestorId = targetBranch[i].id;
      break;
    }
  }
  const firstSummarizedIndex = commonAncestorId === null ? 0 : oldBranch.findIndex((entry) => entry.id === commonAncestorId) + 1;
  return { entries: oldBranch.slice(firstSummarizedIndex), commonAncestorId };
}
async function collectEntriesForBranchSummary(session, oldLeafId, targetId) {
  if (!oldLeafId) {
    return { entries: [], commonAncestorId: null };
  }
  const oldBranch = await session.getBranch(oldLeafId);
  const targetPath = await session.getBranch(targetId);
  return collectEntriesForBranchSummaryFromBranches(oldBranch, targetPath);
}
function getMessageFromEntry2(entry) {
  switch (entry.type) {
    case "message":
      if (entry.message.role === "toolResult") {
        return void 0;
      }
      return entry.message;
    case "custom_message":
      return asAgentMessage(
        createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          entry.timestamp
        )
      );
    case "branch_summary":
      return asAgentMessage(
        createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)
      );
    case "compaction":
      return asAgentMessage(
        createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)
      );
    case "thinking_level_change":
    case "model_change":
    case "custom":
    case "label":
    case "session_info":
    case "leaf":
      return void 0;
  }
  return void 0;
}
function prepareBranchEntries(entries, tokenBudget = 0) {
  const messages = [];
  const fileOps = createFileOps();
  let totalTokens = 0;
  for (const entry of entries) {
    if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
      const details = entry.details;
      if (Array.isArray(details.readFiles)) {
        for (const f of details.readFiles) {
          fileOps.read.add(f);
        }
      }
      if (Array.isArray(details.modifiedFiles)) {
        for (const f of details.modifiedFiles) {
          fileOps.edited.add(f);
        }
      }
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = getMessageFromEntry2(entry);
    if (!message) {
      continue;
    }
    extractFileOpsFromMessage(message, fileOps);
    const tokens = estimateTokens(message);
    if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        if (totalTokens < tokenBudget * 0.9) {
          messages.unshift(message);
          totalTokens += tokens;
        }
      }
      break;
    }
    messages.unshift(message);
    totalTokens += tokens;
  }
  return { messages, fileOps, totalTokens };
}
var BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;
var BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
async function generateBranchSummary(entries, options) {
  const {
    model,
    apiKey,
    headers,
    signal,
    customInstructions,
    replaceInstructions,
    reserveTokens = 16384
  } = options;
  const contextWindow = model.contextWindow || 128e3;
  const tokenBudget = contextWindow - reserveTokens;
  const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);
  if (messages.length === 0) {
    return ok({ summary: "No content to summarize", readFiles: [], modifiedFiles: [] });
  }
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  let instructions;
  if (replaceInstructions && customInstructions) {
    instructions = customInstructions;
  } else if (customInstructions) {
    instructions = `${BRANCH_SUMMARY_PROMPT}

Additional focus: ${customInstructions}`;
  } else {
    instructions = BRANCH_SUMMARY_PROMPT;
  }
  const promptText = `<conversation>
${conversationText}
</conversation>

${instructions}`;
  const summarizationMessages = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now()
    }
  ];
  const context = { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages };
  const streamOptions = { apiKey, headers, signal, maxTokens: 2048 };
  const response = options.streamFn ? await (await options.streamFn(model, context, streamOptions)).result() : await resolveAgentCoreCompleteFn(options.runtime)(model, context, streamOptions);
  if (response.stopReason === "aborted") {
    return err(
      new BranchSummaryError("aborted", response.errorMessage || "Branch summary aborted")
    );
  }
  if (response.stopReason === "error") {
    return err(
      new BranchSummaryError(
        "summarization_failed",
        `Branch summary failed: ${response.errorMessage || "Unknown error"}`
      )
    );
  }
  let summary = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  summary = BRANCH_SUMMARY_PREAMBLE + summary;
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);
  return ok({
    summary: summary || "No summary generated",
    readFiles,
    modifiedFiles
  });
}

// vendor/openclaw/packages/agent-core/src/harness/file-loader-utils.ts
import { parse } from "yaml";
function parseFrontmatter(content) {
  try {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("---")) {
      return { ok: true, value: { frontmatter: {}, body: normalized } };
    }
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) {
      return { ok: true, value: { frontmatter: {}, body: normalized } };
    }
    const yamlString = normalized.slice(4, endIndex);
    const body = normalized.slice(endIndex + 4).trim();
    return {
      ok: true,
      value: { frontmatter: parse(yamlString) ?? {}, body }
    };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}
async function resolveFileInfoKind(env, info, diagnostics) {
  if (info.kind === "file" || info.kind === "directory") {
    return info.kind;
  }
  const canonicalPath = await env.canonicalPath(info.path);
  if (!canonicalPath.ok) {
    if (canonicalPath.error.code !== "not_found") {
      diagnostics.push({
        type: "warning",
        code: "file_info_failed",
        message: canonicalPath.error.message,
        path: info.path
      });
    }
    return void 0;
  }
  const target = await env.fileInfo(canonicalPath.value);
  if (!target.ok) {
    if (target.error.code !== "not_found") {
      diagnostics.push({
        type: "warning",
        code: "file_info_failed",
        message: target.error.message,
        path: info.path
      });
    }
    return void 0;
  }
  return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : void 0;
}
function joinEnvPath(base, child) {
  return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}
function dirnameEnvPath(path) {
  const normalized = path.replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex <= 0 ? "/" : normalized.slice(0, slashIndex);
}
function basenameEnvPath(path) {
  const normalized = path.replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}
function relativeEnvPath(root, path) {
  const normalizedRoot = root.replace(/\/+$/, "");
  const normalizedPath = path.replace(/\/+$/, "");
  if (normalizedPath === normalizedRoot) {
    return "";
  }
  return normalizedPath.startsWith(`${normalizedRoot}/`) ? normalizedPath.slice(normalizedRoot.length + 1) : normalizedPath.replace(/^\/+/, "");
}

// vendor/openclaw/packages/agent-core/src/harness/prompt-template-arguments.ts
function parseCommandArgs(argsString) {
  const args = [];
  let current = "";
  let inQuote = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    args.push(current);
  }
  return args;
}
function parseSafeNonNegativeInteger(raw) {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : void 0;
}
function substituteArgs(content, args) {
  let result = content;
  result = result.replace(/\$(\d+)/g, (_, num) => {
    const parsed = parseSafeNonNegativeInteger(num);
    if (parsed === void 0 || parsed <= 0) {
      return "";
    }
    return args[parsed - 1] ?? "";
  });
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_, startStr, lengthStr) => {
      const parsedStart = parseSafeNonNegativeInteger(startStr);
      if (parsedStart === void 0) {
        return "";
      }
      let start = parsedStart - 1;
      if (start < 0) {
        start = 0;
      }
      if (lengthStr) {
        const length = parseSafeNonNegativeInteger(lengthStr);
        if (length === void 0) {
          return "";
        }
        return args.slice(start, start + length).join(" ");
      }
      return args.slice(start).join(" ");
    }
  );
  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);
  return result;
}

// vendor/openclaw/packages/agent-core/src/harness/prompt-templates.ts
async function loadPromptTemplates(env, paths) {
  const promptTemplates = [];
  const diagnostics = [];
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    const infoResult = await env.fileInfo(path);
    if (!infoResult.ok) {
      if (infoResult.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: infoResult.error.message,
          path
        });
      }
      continue;
    }
    const info = infoResult.value;
    const kind = await resolveFileInfoKind(env, info, diagnostics);
    if (kind === "directory") {
      const result = await loadTemplatesFromDir(env, info.path);
      promptTemplates.push(...result.promptTemplates);
      diagnostics.push(...result.diagnostics);
    } else if (kind === "file" && info.name.endsWith(".md")) {
      const result = await loadTemplateFromFile(env, info.path);
      if (result.promptTemplate) {
        promptTemplates.push(result.promptTemplate);
      }
      diagnostics.push(...result.diagnostics);
    }
  }
  return { promptTemplates, diagnostics };
}
async function loadSourcedPromptTemplates(env, inputs, mapPromptTemplate) {
  const promptTemplates = [];
  const diagnostics = [];
  for (const input of inputs) {
    const result = await loadPromptTemplates(env, input.path);
    for (const promptTemplate of result.promptTemplates) {
      promptTemplates.push({
        promptTemplate: mapPromptTemplate ? mapPromptTemplate(promptTemplate, input.source) : promptTemplate,
        source: input.source
      });
    }
    for (const diagnostic of result.diagnostics) {
      diagnostics.push({ ...diagnostic, source: input.source });
    }
  }
  return { promptTemplates, diagnostics };
}
async function loadTemplatesFromDir(env, dir) {
  const promptTemplates = [];
  const diagnostics = [];
  const entriesResult = await env.listDir(dir);
  if (!entriesResult.ok) {
    diagnostics.push({
      type: "warning",
      code: "list_failed",
      message: entriesResult.error.message,
      path: dir
    });
    return { promptTemplates, diagnostics };
  }
  const entries = entriesResult.value;
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const kind = await resolveFileInfoKind(env, entry, diagnostics);
    if (kind !== "file" || !entry.name.endsWith(".md")) {
      continue;
    }
    const result = await loadTemplateFromFile(env, entry.path);
    if (result.promptTemplate) {
      promptTemplates.push(result.promptTemplate);
    }
    diagnostics.push(...result.diagnostics);
  }
  return { promptTemplates, diagnostics };
}
async function loadTemplateFromFile(env, filePath) {
  const diagnostics = [];
  const rawContent = await env.readTextFile(filePath);
  if (!rawContent.ok) {
    diagnostics.push({
      type: "warning",
      code: "read_failed",
      message: rawContent.error.message,
      path: filePath
    });
    return { promptTemplate: null, diagnostics };
  }
  const parsed = parseFrontmatter(rawContent.value);
  if (!parsed.ok) {
    diagnostics.push({
      type: "warning",
      code: "parse_failed",
      message: parsed.error.message,
      path: filePath
    });
    return { promptTemplate: null, diagnostics };
  }
  const { frontmatter, body } = parsed.value;
  const firstLine = body.split("\n").find((line) => line.trim());
  let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (!description && firstLine) {
    description = firstLine.slice(0, 60);
    if (firstLine.length > 60) {
      description += "...";
    }
  }
  return {
    promptTemplate: {
      name: basenameEnvPath(filePath).replace(/\.md$/i, ""),
      description,
      content: body
    },
    diagnostics
  };
}
function formatPromptTemplateInvocation(template, args = []) {
  return substituteArgs(template.content, args);
}

// vendor/openclaw/packages/agent-core/src/harness/skills.ts
import ignore from "ignore";
var MAX_NAME_LENGTH = 64;
var MAX_DESCRIPTION_LENGTH = 1024;
var IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
function formatSkillInvocation(skill, additionalInstructions) {
  const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">
References are relative to ${dirnameEnvPath(skill.filePath)}.

${skill.content}
</skill>`;
  return additionalInstructions ? `${skillBlock}

${additionalInstructions}` : skillBlock;
}
async function loadSkills(env, dirs) {
  const skills = [];
  const diagnostics = [];
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    const rootInfoResult = await env.fileInfo(dir);
    if (!rootInfoResult.ok) {
      if (rootInfoResult.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: rootInfoResult.error.message,
          path: dir
        });
      }
      continue;
    }
    const rootInfo = rootInfoResult.value;
    if (await resolveFileInfoKind(env, rootInfo, diagnostics) !== "directory") {
      continue;
    }
    const result = await loadSkillsFromDirInternal(
      env,
      rootInfo.path,
      true,
      ignore(),
      rootInfo.path
    );
    skills.push(...result.skills);
    diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}
async function loadSourcedSkills(env, inputs, mapSkill) {
  const skills = [];
  const diagnostics = [];
  for (const input of inputs) {
    const result = await loadSkills(env, input.path);
    for (const skill of result.skills) {
      skills.push({
        skill: mapSkill ? mapSkill(skill, input.source) : skill,
        source: input.source
      });
    }
    for (const diagnostic of result.diagnostics) {
      diagnostics.push({ ...diagnostic, source: input.source });
    }
  }
  return { skills, diagnostics };
}
async function loadSkillsFromDirInternal(env, dir, includeRootFiles, ignoreMatcher, rootDir) {
  const skills = [];
  const diagnostics = [];
  const dirInfoResult = await env.fileInfo(dir);
  if (!dirInfoResult.ok) {
    if (dirInfoResult.error.code !== "not_found") {
      diagnostics.push({
        type: "warning",
        code: "file_info_failed",
        message: dirInfoResult.error.message,
        path: dir
      });
    }
    return { skills, diagnostics };
  }
  const dirInfo = dirInfoResult.value;
  if (await resolveFileInfoKind(env, dirInfo, diagnostics) !== "directory") {
    return { skills, diagnostics };
  }
  await addIgnoreRules(env, ignoreMatcher, dir, rootDir, diagnostics);
  const entriesResult = await env.listDir(dir);
  if (!entriesResult.ok) {
    diagnostics.push({
      type: "warning",
      code: "list_failed",
      message: entriesResult.error.message,
      path: dir
    });
    return { skills, diagnostics };
  }
  const entries = entriesResult.value;
  for (const entry of entries) {
    if (entry.name !== "SKILL.md") {
      continue;
    }
    const fullPath = entry.path;
    const kind = await resolveFileInfoKind(env, entry, diagnostics);
    if (kind !== "file") {
      continue;
    }
    const relPath = relativeEnvPath(rootDir, fullPath);
    if (ignoreMatcher.ignores(relPath)) {
      continue;
    }
    const result = await loadSkillFromFile(env, fullPath);
    if (result.skill) {
      skills.push(result.skill);
    }
    diagnostics.push(...result.diagnostics);
    return { skills, diagnostics };
  }
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const fullPath = entry.path;
    const kind = await resolveFileInfoKind(env, entry, diagnostics);
    if (!kind) {
      continue;
    }
    const relPath = relativeEnvPath(rootDir, fullPath);
    const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
    if (ignoreMatcher.ignores(ignorePath)) {
      continue;
    }
    if (kind === "directory") {
      const result2 = await loadSkillsFromDirInternal(env, fullPath, false, ignoreMatcher, rootDir);
      skills.push(...result2.skills);
      diagnostics.push(...result2.diagnostics);
      continue;
    }
    if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) {
      continue;
    }
    const result = await loadSkillFromFile(env, fullPath);
    if (result.skill) {
      skills.push(result.skill);
    }
    diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}
async function addIgnoreRules(env, ig, dir, rootDir, diagnostics) {
  const relativeDir = relativeEnvPath(rootDir, dir);
  const prefix = relativeDir ? `${relativeDir}/` : "";
  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = joinEnvPath(dir, filename);
    const info = await env.fileInfo(ignorePath);
    if (!info.ok) {
      if (info.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: info.error.message,
          path: ignorePath
        });
      }
      continue;
    }
    if (info.value.kind !== "file") {
      continue;
    }
    const content = await env.readTextFile(ignorePath);
    if (!content.ok) {
      diagnostics.push({
        type: "warning",
        code: "read_failed",
        message: content.error.message,
        path: ignorePath
      });
      continue;
    }
    const patterns = content.value.split(/\r?\n/).map((line) => prefixIgnorePattern(line, prefix)).filter((line) => Boolean(line));
    if (patterns.length > 0) {
      ig.add(patterns);
    }
  }
}
function prefixIgnorePattern(line, prefix) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) {
    return null;
  }
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}
async function loadSkillFromFile(env, filePath) {
  const diagnostics = [];
  const rawContent = await env.readTextFile(filePath);
  if (!rawContent.ok) {
    diagnostics.push({
      type: "warning",
      code: "read_failed",
      message: rawContent.error.message,
      path: filePath
    });
    return { skill: null, diagnostics };
  }
  const parsed = parseFrontmatter(rawContent.value);
  if (!parsed.ok) {
    diagnostics.push({
      type: "warning",
      code: "parse_failed",
      message: parsed.error.message,
      path: filePath
    });
    return { skill: null, diagnostics };
  }
  const { frontmatter, body } = parsed.value;
  const skillDir = dirnameEnvPath(filePath);
  const parentDirName = basenameEnvPath(skillDir);
  const description = typeof frontmatter.description === "string" ? frontmatter.description : void 0;
  for (const error of validateDescription(description)) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
  }
  const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : void 0;
  const name = frontmatterName || parentDirName;
  for (const error of validateName(name, parentDirName)) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
  }
  if (!description || description.trim() === "") {
    return { skill: null, diagnostics };
  }
  return {
    skill: {
      name,
      description,
      content: body,
      filePath,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true
    },
    diagnostics
  };
}
function validateName(name, parentDirName) {
  const errors = [];
  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("name must not start or end with a hyphen");
  }
  if (name.includes("--")) {
    errors.push("name must not contain consecutive hyphens");
  }
  return errors;
}
function validateDescription(description) {
  const errors = [];
  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }
  return errors;
}

// vendor/openclaw/packages/agent-core/src/harness/agent-harness.ts
function createUserMessage(text, images) {
  const content = [{ type: "text", text }];
  if (images) {
    content.push(...images);
  }
  return { role: "user", content, timestamp: Date.now() };
}
function createFailureMessage(model, error, aborted) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  };
}
function cloneStreamOptions(streamOptions) {
  return {
    ...streamOptions,
    headers: streamOptions?.headers ? { ...streamOptions.headers } : void 0,
    metadata: streamOptions?.metadata ? { ...streamOptions.metadata } : void 0
  };
}
function mergeHeaders(...headers) {
  const merged = {};
  let hasHeaders = false;
  for (const entry of headers) {
    if (!entry) {
      continue;
    }
    Object.assign(merged, entry);
    hasHeaders = true;
  }
  return hasHeaders ? merged : void 0;
}
function applyStreamOptionsPatch(base, patch) {
  const result = cloneStreamOptions(base);
  if (!patch) {
    return result;
  }
  if (Object.hasOwn(patch, "transport")) {
    result.transport = patch.transport;
  }
  if (Object.hasOwn(patch, "timeoutMs")) {
    result.timeoutMs = patch.timeoutMs;
  }
  if (Object.hasOwn(patch, "maxRetries")) {
    result.maxRetries = patch.maxRetries;
  }
  if (Object.hasOwn(patch, "maxRetryDelayMs")) {
    result.maxRetryDelayMs = patch.maxRetryDelayMs;
  }
  if (Object.hasOwn(patch, "cacheRetention")) {
    result.cacheRetention = patch.cacheRetention;
  }
  if (Object.hasOwn(patch, "headers")) {
    if (patch.headers === void 0) {
      result.headers = void 0;
    } else {
      const headers = { ...result.headers };
      for (const [key, value] of Object.entries(patch.headers)) {
        if (value === void 0) {
          delete headers[key];
        } else {
          headers[key] = value;
        }
      }
      result.headers = Object.keys(headers).length > 0 ? headers : void 0;
    }
  }
  if (Object.hasOwn(patch, "metadata")) {
    if (patch.metadata === void 0) {
      result.metadata = void 0;
    } else {
      const metadata = { ...result.metadata };
      for (const [key, value] of Object.entries(patch.metadata)) {
        if (value === void 0) {
          delete metadata[key];
        } else {
          metadata[key] = value;
        }
      }
      result.metadata = Object.keys(metadata).length > 0 ? metadata : void 0;
    }
  }
  return result;
}
var SUBSCRIBER_EVENT_TYPE = "*";
function normalizeHarnessError(error, fallbackCode) {
  if (error instanceof AgentHarnessError) {
    return error;
  }
  const cause = toError(error);
  if (cause instanceof SessionError) {
    return new AgentHarnessError("session", cause.message, cause);
  }
  if (cause instanceof CompactionError) {
    return new AgentHarnessError("compaction", cause.message, cause);
  }
  if (cause instanceof BranchSummaryError) {
    return new AgentHarnessError("branch_summary", cause.message, cause);
  }
  return new AgentHarnessError(fallbackCode, cause.message, cause);
}
function normalizeHookError(error) {
  return normalizeHarnessError(error, "hook");
}
var CoreAgentHarness = class {
  env;
  session;
  phase = "idle";
  runAbortController;
  runPromise;
  pendingSessionWrites = [];
  model;
  thinkingLevel;
  systemPrompt;
  streamOptions;
  getApiKeyAndHeaders;
  runtime;
  resources;
  tools = /* @__PURE__ */ new Map();
  activeToolNames;
  steerQueue = [];
  steeringQueueMode;
  followUpQueue = [];
  followUpQueueMode;
  nextTurnQueue = [];
  handlers = /* @__PURE__ */ new Map();
  constructor(options) {
    this.env = options.env;
    this.session = options.session;
    this.resources = options.resources ?? {};
    this.streamOptions = cloneStreamOptions(options.streamOptions);
    this.systemPrompt = options.systemPrompt;
    this.getApiKeyAndHeaders = options.getApiKeyAndHeaders;
    this.runtime = options.runtime;
    for (const tool of options.tools ?? []) {
      this.tools.set(tool.name, tool);
    }
    this.model = options.model;
    this.thinkingLevel = options.thinkingLevel ?? "off";
    this.activeToolNames = options.activeToolNames ?? (options.tools ?? []).map((tool) => tool.name);
    this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
    this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
  }
  getHandlers(type) {
    return this.handlers.get(type);
  }
  async emitOwn(event, signal) {
    for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
      try {
        await listener(event, signal);
      } catch (error) {
        throw normalizeHookError(error);
      }
    }
  }
  async emitAny(event, signal) {
    for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
      try {
        await listener(event, signal);
      } catch (error) {
        throw normalizeHookError(error);
      }
    }
  }
  async emitHook(event) {
    const handlers = this.getHandlers(event.type);
    if (!handlers || handlers.size === 0) {
      return void 0;
    }
    let lastResult;
    for (const handler of handlers) {
      try {
        const result = await handler(event);
        if (result !== void 0) {
          lastResult = result;
        }
      } catch (error) {
        throw normalizeHookError(error);
      }
    }
    return lastResult;
  }
  async emitBeforeProviderRequest(model, sessionId, streamOptions) {
    const handlers = this.getHandlers("before_provider_request");
    let current = cloneStreamOptions(streamOptions);
    if (!handlers || handlers.size === 0) {
      return current;
    }
    for (const handler of handlers) {
      try {
        const result = await handler({
          type: "before_provider_request",
          model,
          sessionId,
          streamOptions: cloneStreamOptions(current)
        });
        if (result?.streamOptions) {
          current = applyStreamOptionsPatch(current, result.streamOptions);
        }
      } catch (error) {
        throw normalizeHookError(error);
      }
    }
    return current;
  }
  async emitBeforeProviderPayload(model, payload) {
    const handlers = this.getHandlers("before_provider_payload");
    let current = payload;
    if (!handlers || handlers.size === 0) {
      return current;
    }
    for (const handler of handlers) {
      try {
        const result = await handler({
          type: "before_provider_payload",
          model,
          payload: current
        });
        if (result !== void 0) {
          current = result.payload;
        }
      } catch (error) {
        throw normalizeHookError(error);
      }
    }
    return current;
  }
  async emitQueueUpdate() {
    await this.emitOwn({
      type: "queue_update",
      steer: [...this.steerQueue],
      followUp: [...this.followUpQueue],
      nextTurn: [...this.nextTurnQueue]
    });
  }
  startRunPromise() {
    let finish = () => {
    };
    this.runPromise = new Promise((resolve2) => {
      finish = resolve2;
    });
    return () => {
      this.runPromise = void 0;
      finish();
    };
  }
  async createTurnState() {
    const context = await this.session.buildContext();
    const resources = this.getResources();
    const sessionMetadata = await this.session.getMetadata();
    const tools = [...this.tools.values()];
    const activeTools = this.activeToolNames.map((name) => this.tools.get(name)).filter((tool) => tool !== void 0);
    let systemPrompt = "You are a helpful assistant.";
    if (typeof this.systemPrompt === "string") {
      systemPrompt = this.systemPrompt;
    } else if (this.systemPrompt) {
      systemPrompt = await this.systemPrompt({
        env: this.env,
        session: this.session,
        model: this.model,
        thinkingLevel: this.thinkingLevel,
        activeTools,
        resources
      });
    }
    return {
      messages: context.messages,
      resources,
      streamOptions: cloneStreamOptions(this.streamOptions),
      sessionId: sessionMetadata.id,
      systemPrompt,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      tools,
      activeTools
    };
  }
  createContext(turnState, systemPrompt) {
    return {
      systemPrompt: systemPrompt ?? turnState.systemPrompt,
      messages: turnState.messages.slice(),
      tools: turnState.activeTools.slice()
    };
  }
  createStreamFn(getTurnState) {
    return async (model, context, streamOptions) => {
      const turnState = getTurnState();
      const auth = await this.getApiKeyAndHeaders?.(model);
      const snapshotOptions = {
        ...turnState.streamOptions,
        headers: mergeHeaders(turnState.streamOptions.headers, auth?.headers)
      };
      const requestOptions = await this.emitBeforeProviderRequest(
        model,
        turnState.sessionId,
        snapshotOptions
      );
      return resolveAgentCoreStreamFn(this.runtime)(model, context, {
        cacheRetention: requestOptions.cacheRetention,
        headers: requestOptions.headers,
        maxRetries: requestOptions.maxRetries,
        maxRetryDelayMs: requestOptions.maxRetryDelayMs,
        metadata: requestOptions.metadata,
        onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
        onResponse: async (response) => {
          const headers = { ...response.headers };
          await this.emitOwn(
            { type: "after_provider_response", status: response.status, headers },
            streamOptions?.signal
          );
        },
        reasoning: streamOptions?.reasoning,
        signal: streamOptions?.signal,
        sessionId: turnState.sessionId,
        timeoutMs: requestOptions.timeoutMs,
        transport: requestOptions.transport,
        apiKey: auth?.apiKey
      });
    };
  }
  async drainQueuedMessages(queue, mode) {
    const messages = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
    if (messages.length === 0) {
      return messages;
    }
    try {
      await this.emitQueueUpdate();
      return messages;
    } catch (error) {
      queue.unshift(...messages);
      throw normalizeHookError(error);
    }
  }
  createLoopConfig(getTurnState, setTurnState) {
    const turnState = getTurnState();
    return {
      model: turnState.model,
      reasoning: turnState.thinkingLevel === "off" ? void 0 : turnState.thinkingLevel,
      convertToLlm,
      transformContext: async (messages) => {
        const result = await this.emitHook({ type: "context", messages: [...messages] });
        return result?.messages ?? messages;
      },
      beforeToolCall: async ({ toolCall, args }) => {
        const result = await this.emitHook({
          type: "tool_call",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: args
        });
        return result ? { block: result.block, reason: result.reason } : void 0;
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        const patch = await this.emitHook({
          type: "tool_result",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: args,
          content: result.content,
          details: result.details,
          isError
        });
        return patch ? {
          content: patch.content,
          details: patch.details,
          isError: patch.isError,
          terminate: patch.terminate
        } : void 0;
      },
      prepareNextTurn: async () => {
        await this.flushPendingSessionWrites();
        const nextTurnState = await this.createTurnState();
        setTurnState(nextTurnState);
        return {
          context: this.createContext(nextTurnState),
          model: nextTurnState.model,
          thinkingLevel: nextTurnState.thinkingLevel
        };
      },
      getSteeringMessages: async () => this.drainQueuedMessages(this.steerQueue, this.steeringQueueMode),
      getFollowUpMessages: async () => this.drainQueuedMessages(this.followUpQueue, this.followUpQueueMode)
    };
  }
  validateToolNames(toolNames, tools = this.tools) {
    const missing = toolNames.filter((name) => !tools.has(name));
    if (missing.length > 0) {
      throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
    }
  }
  async flushPendingSessionWrites() {
    while (this.pendingSessionWrites.length > 0) {
      const write = this.pendingSessionWrites[0];
      if (write.type === "message") {
        await this.session.appendMessage(write.message);
      } else if (write.type === "model_change") {
        await this.session.appendModelChange(write.provider, write.modelId);
      } else if (write.type === "thinking_level_change") {
        await this.session.appendThinkingLevelChange(write.thinkingLevel);
      } else if (write.type === "custom") {
        await this.session.appendCustomEntry(write.customType, write.data);
      } else if (write.type === "custom_message") {
        await this.session.appendCustomMessageEntry(
          write.customType,
          write.content,
          write.display,
          write.details
        );
      } else if (write.type === "label") {
        await this.session.appendLabel(write.targetId, write.label);
      } else if (write.type === "session_info") {
        await this.session.appendSessionName(write.name ?? "");
      } else if (write.type === "leaf") {
        await this.session.getStorage().setLeafId(write.targetId);
      }
      this.pendingSessionWrites.shift();
    }
  }
  async handleAgentEvent(event, signal) {
    if (event.type === "message_end") {
      await this.session.appendMessage(event.message);
      await this.emitAny(event, signal);
      return;
    }
    if (event.type === "turn_end") {
      let eventError;
      try {
        await this.emitAny(event, signal);
      } catch (error) {
        eventError = error;
      }
      const hadPendingMutations = this.pendingSessionWrites.length > 0;
      await this.flushPendingSessionWrites();
      if (eventError) {
        throw toLintErrorObject2(eventError, "Non-Error thrown");
      }
      await this.emitOwn({ type: "save_point", hadPendingMutations });
      return;
    }
    if (event.type === "agent_end") {
      await this.flushPendingSessionWrites();
      this.phase = "idle";
      await this.emitAny(event, signal);
      await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
      return;
    }
    await this.emitAny(event, signal);
  }
  async emitRunFailure(model, error, aborted, signal) {
    const failureMessage = createFailureMessage(model, error, aborted);
    await this.handleAgentEvent({ type: "message_start", message: failureMessage }, signal);
    await this.handleAgentEvent({ type: "message_end", message: failureMessage }, signal);
    await this.handleAgentEvent(
      { type: "turn_end", message: failureMessage, toolResults: [] },
      signal
    );
    await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] }, signal);
    return [failureMessage];
  }
  async executeTurn(turnState, text, options) {
    let activeTurnState = turnState;
    let messages = [createUserMessage(text, options?.images)];
    if (this.nextTurnQueue.length > 0) {
      const queuedMessages = this.nextTurnQueue.splice(0);
      try {
        await this.emitQueueUpdate();
      } catch (error) {
        this.nextTurnQueue.unshift(...queuedMessages);
        throw normalizeHookError(error);
      }
      messages = [...queuedMessages, messages[0]];
    }
    const beforeResult = await this.emitHook({
      type: "before_agent_start",
      prompt: text,
      images: options?.images,
      systemPrompt: turnState.systemPrompt,
      resources: turnState.resources
    });
    if (beforeResult?.messages) {
      messages = [...messages, ...beforeResult.messages];
    }
    const abortController = new AbortController();
    const getTurnState = () => activeTurnState;
    const setTurnState = (nextTurnState) => {
      activeTurnState = nextTurnState;
    };
    this.runAbortController = abortController;
    const runResultPromise = (async () => {
      try {
        return await runAgentLoop(
          messages,
          this.createContext(turnState, beforeResult?.systemPrompt),
          this.createLoopConfig(getTurnState, setTurnState),
          (event) => this.handleAgentEvent(event, abortController.signal),
          abortController.signal,
          this.createStreamFn(getTurnState)
        );
      } catch (error) {
        try {
          return await this.emitRunFailure(
            activeTurnState.model,
            error,
            abortController.signal.aborted,
            abortController.signal
          );
        } catch (failureError) {
          const cause = new AggregateError(
            [toError(error), toError(failureError)],
            "Agent run failed and failure reporting failed"
          );
          throw new AgentHarnessError("unknown", cause.message, cause);
        }
      }
    })();
    try {
      const newMessages = await runResultPromise;
      for (let i = newMessages.length - 1; i >= 0; i--) {
        const message = newMessages[i];
        if (message.role === "assistant") {
          return message;
        }
      }
      throw new AgentHarnessError(
        "invalid_state",
        "AgentHarness prompt completed without an assistant message"
      );
    } finally {
      try {
        await this.flushPendingSessionWrites();
      } finally {
        this.runAbortController = void 0;
      }
    }
  }
  async prompt(text, options) {
    if (this.phase !== "idle") {
      throw new AgentHarnessError("busy", "AgentHarness is busy");
    }
    this.phase = "turn";
    const finishRunPromise = this.startRunPromise();
    try {
      const turnState = await this.createTurnState();
      return await this.executeTurn(turnState, text, options);
    } catch (error) {
      this.phase = "idle";
      throw normalizeHarnessError(error, "unknown");
    } finally {
      finishRunPromise();
    }
  }
  async skill(name, additionalInstructions) {
    if (this.phase !== "idle") {
      throw new AgentHarnessError("busy", "AgentHarness is busy");
    }
    this.phase = "turn";
    const finishRunPromise = this.startRunPromise();
    try {
      const turnState = await this.createTurnState();
      const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
      if (!skill) {
        throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
      }
      return await this.executeTurn(
        turnState,
        formatSkillInvocation(skill, additionalInstructions)
      );
    } catch (error) {
      this.phase = "idle";
      throw normalizeHarnessError(error, "unknown");
    } finally {
      finishRunPromise();
    }
  }
  async promptFromTemplate(name, args = []) {
    if (this.phase !== "idle") {
      throw new AgentHarnessError("busy", "AgentHarness is busy");
    }
    this.phase = "turn";
    const finishRunPromise = this.startRunPromise();
    try {
      const turnState = await this.createTurnState();
      const template = (turnState.resources.promptTemplates ?? []).find(
        (candidate) => candidate.name === name
      );
      if (!template) {
        throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
      }
      return await this.executeTurn(turnState, formatPromptTemplateInvocation(template, args));
    } catch (error) {
      this.phase = "idle";
      throw normalizeHarnessError(error, "unknown");
    } finally {
      finishRunPromise();
    }
  }
  async steer(text, options) {
    if (this.phase === "idle") {
      throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
    }
    this.steerQueue.push(createUserMessage(text, options?.images));
    await this.emitQueueUpdate();
  }
  async followUp(text, options) {
    if (this.phase === "idle") {
      throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
    }
    this.followUpQueue.push(createUserMessage(text, options?.images));
    await this.emitQueueUpdate();
  }
  async nextTurn(text, options) {
    this.nextTurnQueue.push(createUserMessage(text, options?.images));
    await this.emitQueueUpdate();
  }
  async appendMessage(message) {
    try {
      if (this.phase === "idle") {
        await this.session.appendMessage(message);
      } else {
        this.pendingSessionWrites.push({ type: "message", message });
      }
    } catch (error) {
      throw normalizeHarnessError(error, "session");
    }
  }
  async compact(customInstructions) {
    if (this.phase !== "idle") {
      throw new AgentHarnessError("busy", "compact() requires idle harness");
    }
    this.phase = "compaction";
    try {
      const model = this.model;
      if (!model) {
        throw new AgentHarnessError("invalid_state", "No model set for compaction");
      }
      const auth = await this.getApiKeyAndHeaders?.(model);
      if (!auth) {
        throw new AgentHarnessError("auth", "No auth available for compaction");
      }
      const branchEntries = await this.session.getBranch();
      const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
      if (!preparationResult.ok) {
        throw preparationResult.error;
      }
      const preparation = preparationResult.value;
      if (!preparation) {
        throw new AgentHarnessError("compaction", "Nothing to compact");
      }
      const hookResult = await this.emitHook({
        type: "session_before_compact",
        preparation,
        branchEntries,
        customInstructions,
        signal: new AbortController().signal
      });
      if (hookResult?.cancel) {
        throw new AgentHarnessError("compaction", "Compaction cancelled");
      }
      const provided = hookResult?.compaction;
      const compactResult = provided ? { ok: true, value: provided } : await compact(
        preparation,
        model,
        auth.apiKey,
        auth.headers,
        customInstructions,
        void 0,
        this.thinkingLevel,
        void 0,
        this.runtime
      );
      if (!compactResult.ok) {
        throw compactResult.error;
      }
      const result = compactResult.value;
      const entryId = await this.session.appendCompaction(
        result.summary,
        result.firstKeptEntryId,
        result.tokensBefore,
        result.details,
        provided !== void 0
      );
      const entry = await this.session.getEntry(entryId);
      if (entry?.type === "compaction") {
        await this.emitOwn({
          type: "session_compact",
          compactionEntry: entry,
          fromHook: provided !== void 0
        });
      }
      return result;
    } catch (error) {
      throw normalizeHarnessError(error, "compaction");
    } finally {
      this.phase = "idle";
    }
  }
  async navigateTree(targetId, options) {
    if (this.phase !== "idle") {
      throw new AgentHarnessError("busy", "navigateTree() requires idle harness");
    }
    this.phase = "branch_summary";
    try {
      const oldLeafId = await this.session.getLeafId();
      if (oldLeafId === targetId) {
        return { cancelled: false };
      }
      const targetEntry = await this.session.getEntry(targetId);
      if (!targetEntry) {
        throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
      }
      const { entries, commonAncestorId } = await collectEntriesForBranchSummary(
        this.session,
        oldLeafId,
        targetId
      );
      const preparation = {
        targetId,
        oldLeafId,
        commonAncestorId,
        entriesToSummarize: entries,
        userWantsSummary: options?.summarize ?? false,
        customInstructions: options?.customInstructions,
        replaceInstructions: options?.replaceInstructions,
        label: options?.label
      };
      const signal = new AbortController().signal;
      const hookResult = await this.emitHook({ type: "session_before_tree", preparation, signal });
      if (hookResult?.cancel) {
        return { cancelled: true };
      }
      let summaryEntry;
      let summaryText = hookResult?.summary?.summary;
      let summaryDetails = hookResult?.summary?.details;
      if (!summaryText && options?.summarize && entries.length > 0) {
        const model = this.model;
        if (!model) {
          throw new AgentHarnessError("invalid_state", "No model set for branch summary");
        }
        const auth = await this.getApiKeyAndHeaders?.(model);
        if (!auth) {
          throw new AgentHarnessError("auth", "No auth available for branch summary");
        }
        const branchSummary = await generateBranchSummary(entries, {
          model,
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: new AbortController().signal,
          runtime: this.runtime,
          customInstructions: hookResult?.customInstructions ?? options?.customInstructions,
          replaceInstructions: hookResult?.replaceInstructions ?? options?.replaceInstructions
        });
        if (!branchSummary.ok) {
          if (branchSummary.error.code === "aborted") {
            return { cancelled: true };
          }
          throw new AgentHarnessError(
            "branch_summary",
            branchSummary.error.message,
            branchSummary.error
          );
        }
        summaryText = branchSummary.value.summary;
        summaryDetails = {
          readFiles: branchSummary.value.readFiles,
          modifiedFiles: branchSummary.value.modifiedFiles
        };
      }
      let editorText;
      let newLeafId;
      if (targetEntry.type === "message" && targetEntry.message.role === "user") {
        newLeafId = targetEntry.parentId;
        const content = targetEntry.message.content;
        editorText = typeof content === "string" ? content : content.filter(
          (c) => c.type === "text"
        ).map((c) => c.text).join("");
      } else if (targetEntry.type === "custom_message") {
        newLeafId = targetEntry.parentId;
        editorText = typeof targetEntry.content === "string" ? targetEntry.content : targetEntry.content.filter(
          (c) => c.type === "text"
        ).map((c) => c.text).join("");
      } else {
        newLeafId = targetId;
      }
      const summaryId = await this.session.moveTo(
        newLeafId,
        summaryText ? {
          summary: summaryText,
          details: summaryDetails,
          fromHook: hookResult?.summary !== void 0
        } : void 0
      );
      if (summaryId) {
        const entry = await this.session.getEntry(summaryId);
        if (entry?.type === "branch_summary") {
          summaryEntry = entry;
        }
      }
      await this.emitOwn({
        type: "session_tree",
        newLeafId: await this.session.getLeafId(),
        oldLeafId,
        summaryEntry,
        fromHook: hookResult?.summary !== void 0
      });
      return { cancelled: false, editorText, summaryEntry };
    } catch (error) {
      throw normalizeHarnessError(error, "branch_summary");
    } finally {
      this.phase = "idle";
    }
  }
  getModel() {
    return this.model;
  }
  getThinkingLevel() {
    return this.thinkingLevel;
  }
  async setModel(model) {
    try {
      const previousModel = this.model;
      if (this.phase === "idle") {
        await this.session.appendModelChange(model.provider, model.id);
      } else {
        this.pendingSessionWrites.push({
          type: "model_change",
          provider: model.provider,
          modelId: model.id
        });
      }
      this.model = model;
      await this.emitOwn({ type: "model_select", model, previousModel, source: "set" });
    } catch (error) {
      throw normalizeHarnessError(error, "session");
    }
  }
  async setThinkingLevel(level) {
    try {
      const previousLevel = this.thinkingLevel;
      if (this.phase === "idle") {
        await this.session.appendThinkingLevelChange(level);
      } else {
        this.pendingSessionWrites.push({ type: "thinking_level_change", thinkingLevel: level });
      }
      this.thinkingLevel = level;
      await this.emitOwn({ type: "thinking_level_select", level, previousLevel });
    } catch (error) {
      throw normalizeHarnessError(error, "session");
    }
  }
  async setActiveTools(toolNames) {
    try {
      this.validateToolNames(toolNames);
      this.activeToolNames = [...toolNames];
    } catch (error) {
      throw normalizeHarnessError(error, "invalid_argument");
    }
  }
  getSteeringMode() {
    return this.steeringQueueMode;
  }
  async setSteeringMode(mode) {
    this.steeringQueueMode = mode;
  }
  getFollowUpMode() {
    return this.followUpQueueMode;
  }
  async setFollowUpMode(mode) {
    this.followUpQueueMode = mode;
  }
  getResources() {
    return {
      skills: this.resources.skills?.slice(),
      promptTemplates: this.resources.promptTemplates?.slice()
    };
  }
  async setResources(resources) {
    const previousResources = this.getResources();
    this.resources = {
      skills: resources.skills?.slice(),
      promptTemplates: resources.promptTemplates?.slice()
    };
    await this.emitOwn({
      type: "resources_update",
      resources: this.getResources(),
      previousResources
    });
  }
  getStreamOptions() {
    return cloneStreamOptions(this.streamOptions);
  }
  async setStreamOptions(streamOptions) {
    this.streamOptions = cloneStreamOptions(streamOptions);
  }
  async setTools(tools, activeToolNames) {
    try {
      const nextTools = new Map(tools.map((tool) => [tool.name, tool]));
      const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;
      this.validateToolNames(nextActiveToolNames, nextTools);
      this.tools = nextTools;
      this.activeToolNames = [...nextActiveToolNames];
    } catch (error) {
      throw normalizeHarnessError(error, "invalid_argument");
    }
  }
  async abort() {
    const clearedSteer = [...this.steerQueue];
    const clearedFollowUp = [...this.followUpQueue];
    this.steerQueue = [];
    this.followUpQueue = [];
    this.runAbortController?.abort();
    const errors = [];
    try {
      await this.emitQueueUpdate();
    } catch (error) {
      errors.push(toError(error));
    }
    try {
      await this.waitForIdle();
    } catch (error) {
      errors.push(toError(error));
    }
    try {
      await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp });
    } catch (error) {
      errors.push(toError(error));
    }
    if (errors.length > 0) {
      const cause = errors.length === 1 ? errors[0] : new AggregateError(errors, "Abort completed with errors");
      throw normalizeHarnessError(cause, "hook");
    }
    return { clearedSteer, clearedFollowUp };
  }
  async waitForIdle() {
    await this.runPromise;
  }
  subscribe(listener) {
    let handlers = this.handlers.get(SUBSCRIBER_EVENT_TYPE);
    if (!handlers) {
      handlers = /* @__PURE__ */ new Set();
      this.handlers.set(SUBSCRIBER_EVENT_TYPE, handlers);
    }
    handlers.add(listener);
    return () => handlers.delete(listener);
  }
  on(type, handler) {
    let handlers = this.handlers.get(type);
    if (!handlers) {
      handlers = /* @__PURE__ */ new Set();
      this.handlers.set(type, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }
};
function toLintErrorObject2(value, fallbackMessage) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if (typeof value === "object" && value !== null || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

// vendor/openclaw/packages/agent-core/src/harness/system-prompt.ts
function formatSkillsForSystemPrompt(skills) {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>"
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// vendor/openclaw/packages/agent-core/src/harness/session/uuid.ts
var lastTimestamp = -Infinity;
var sequence = 0;
function fillRandomBytes(bytes) {
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
    return;
  }
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
}
function uuidv7() {
  const random = new Uint8Array(16);
  fillRandomBytes(random);
  const timestamp = Date.now();
  if (timestamp > lastTimestamp) {
    sequence = random[6] * 16777216 + random[7] * 65536 + random[8] * 256 + random[9];
    lastTimestamp = timestamp;
  } else {
    sequence = sequence + 1 >>> 0;
    if (sequence === 0) {
      lastTimestamp++;
    }
  }
  const bytes = new Uint8Array(16);
  bytes[0] = lastTimestamp / 1099511627776 & 255;
  bytes[1] = lastTimestamp / 4294967296 & 255;
  bytes[2] = lastTimestamp / 16777216 & 255;
  bytes[3] = lastTimestamp / 65536 & 255;
  bytes[4] = lastTimestamp / 256 & 255;
  bytes[5] = lastTimestamp & 255;
  bytes[6] = 112 | sequence >>> 28 & 15;
  bytes[7] = sequence >>> 20 & 255;
  bytes[8] = 128 | sequence >>> 14 & 63;
  bytes[9] = sequence >>> 6 & 255;
  bytes[10] = (sequence & 63) << 2 | random[10] & 3;
  bytes[11] = random[11];
  bytes[12] = random[12];
  bytes[13] = random[13];
  bytes[14] = random[14];
  bytes[15] = random[15];
  return formatUuid(bytes);
}
function formatUuid(bytes) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

// vendor/openclaw/packages/agent-core/src/harness/session/repo-utils.ts
function createSessionId() {
  return uuidv7();
}
function createTimestamp() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function toSession(storage) {
  return new Session(storage);
}
function getFileSystemResultOrThrow(result, message) {
  if (!result.ok) {
    const code = result.error.code === "not_found" ? "not_found" : "storage";
    throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
  }
  return result.value;
}
async function getEntriesToFork(storage, options) {
  if (!options.entryId) {
    return storage.getEntries();
  }
  const target = await storage.getEntry(options.entryId);
  if (!target) {
    throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
  }
  let effectiveLeafId;
  if ((options.position ?? "before") === "at") {
    effectiveLeafId = target.id;
  } else {
    if (target.type !== "message" || target.message.role !== "user") {
      throw new SessionError(
        "invalid_fork_target",
        `Entry ${options.entryId} is not a user message`
      );
    }
    effectiveLeafId = target.parentId;
  }
  return storage.getPathToRoot(effectiveLeafId);
}

// vendor/openclaw/packages/agent-core/src/harness/session/storage-base.ts
function updateLabelCache(labelsById, entry) {
  if (entry.type !== "label") {
    return;
  }
  const label = entry.label?.trim();
  if (label) {
    labelsById.set(entry.targetId, label);
  } else {
    labelsById.delete(entry.targetId);
  }
}
function buildLabelsById(entries) {
  const labelsById = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    updateLabelCache(labelsById, entry);
  }
  return labelsById;
}
function generateEntryId(byId) {
  for (let i = 0; i < 100; i++) {
    const id = uuidv7().slice(0, 8);
    if (!byId.has(id)) {
      return id;
    }
  }
  return uuidv7();
}
function leafIdAfterEntry(entry) {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}
function resolveLeafId(entries) {
  let leafId = null;
  for (const entry of entries) {
    leafId = leafIdAfterEntry(entry);
  }
  return leafId;
}
var BaseSessionStorage = class {
  metadata;
  entries;
  byId;
  labelsById;
  leafId;
  constructor(metadata, entries, leafId = resolveLeafId(entries)) {
    this.metadata = metadata;
    this.entries = entries;
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
    this.labelsById = buildLabelsById(entries);
    this.leafId = leafId;
    if (this.leafId !== null && !this.byId.has(this.leafId)) {
      throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
    }
  }
  async getMetadata() {
    return this.metadata;
  }
  async getLeafId() {
    if (this.leafId !== null && !this.byId.has(this.leafId)) {
      throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
    }
    return this.leafId;
  }
  createLeafEntry(leafId) {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    return {
      type: "leaf",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      targetId: leafId
    };
  }
  async createEntryId() {
    return generateEntryId(this.byId);
  }
  recordEntry(entry) {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    updateLabelCache(this.labelsById, entry);
    this.leafId = leafIdAfterEntry(entry);
  }
  async getEntry(id) {
    return this.byId.get(id);
  }
  async findEntries(type) {
    return this.entries.filter(
      (entry) => entry.type === type
    );
  }
  async getLabel(id) {
    return this.labelsById.get(id);
  }
  async getPathToRoot(leafId) {
    if (leafId === null) {
      return [];
    }
    const path = [];
    let current = this.byId.get(leafId);
    if (!current) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    while (current) {
      path.unshift(current);
      if (!current.parentId) {
        break;
      }
      const parent = this.byId.get(current.parentId);
      if (!parent) {
        throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      }
      current = parent;
    }
    return path;
  }
  async getEntries() {
    return [...this.entries];
  }
};

// vendor/openclaw/packages/agent-core/src/harness/session/jsonl-storage.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function invalidSession(filePath, message, cause) {
  return new SessionError(
    "invalid_session",
    `Invalid JSONL session file ${filePath}: ${message}`,
    cause
  );
}
function invalidEntry(filePath, lineNumber, message, cause) {
  return new SessionError(
    "invalid_entry",
    `Invalid JSONL session file ${filePath}: line ${lineNumber} ${message}`,
    cause
  );
}
function parseHeaderLine(line, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw invalidSession(filePath, "first line is not a valid session header", toError(error));
  }
  if (!isRecord2(parsed)) {
    throw invalidSession(filePath, "first line is not a valid session header");
  }
  if (parsed.type !== "session") {
    throw invalidSession(filePath, "first line is not a valid session header");
  }
  if (parsed.version !== 3) {
    throw invalidSession(filePath, "unsupported session version");
  }
  if (typeof parsed.id !== "string" || !parsed.id) {
    throw invalidSession(filePath, "session header is missing id");
  }
  if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
    throw invalidSession(filePath, "session header is missing timestamp");
  }
  if (parseSessionTimestampMs(parsed.timestamp) === void 0) {
    throw invalidSession(filePath, "session header has invalid timestamp");
  }
  if (typeof parsed.cwd !== "string" || !parsed.cwd) {
    throw invalidSession(filePath, "session header is missing cwd");
  }
  if (parsed.parentSession !== void 0 && typeof parsed.parentSession !== "string") {
    throw invalidSession(filePath, "session header parentSession must be a string");
  }
  return {
    type: "session",
    version: 3,
    id: parsed.id,
    timestamp: parsed.timestamp,
    cwd: parsed.cwd,
    parentSession: parsed.parentSession
  };
}
function parseEntryLine(line, filePath, lineNumber) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw invalidEntry(filePath, lineNumber, "is not valid JSON", toError(error));
  }
  if (!isRecord2(parsed)) {
    throw invalidEntry(filePath, lineNumber, "is not a valid session entry");
  }
  if (typeof parsed.type !== "string") {
    throw invalidEntry(filePath, lineNumber, "is missing entry type");
  }
  if (typeof parsed.id !== "string" || !parsed.id) {
    throw invalidEntry(filePath, lineNumber, "is missing entry id");
  }
  if (parsed.parentId !== null && typeof parsed.parentId !== "string") {
    throw invalidEntry(filePath, lineNumber, "has invalid parentId");
  }
  if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
    throw invalidEntry(filePath, lineNumber, "is missing timestamp");
  }
  if (parseSessionTimestampMs(parsed.timestamp) === void 0) {
    throw invalidEntry(filePath, lineNumber, "has invalid timestamp");
  }
  if (parsed.type === "leaf" && parsed.targetId !== null && typeof parsed.targetId !== "string") {
    throw invalidEntry(filePath, lineNumber, "has invalid targetId");
  }
  return parsed;
}
function headerToSessionMetadata(header, path) {
  return {
    id: header.id,
    createdAt: header.timestamp,
    cwd: header.cwd,
    path,
    parentSessionPath: header.parentSession
  };
}
async function loadJsonlSessionMetadata(fs, filePath) {
  const lines = getFileSystemResultOrThrow(
    await fs.readTextLines(filePath, { maxLines: 1 }),
    `Failed to read session header ${filePath}`
  );
  const line = lines[0];
  if (line?.trim()) {
    return headerToSessionMetadata(parseHeaderLine(line, filePath), filePath);
  }
  throw invalidSession(filePath, "missing session header");
}
async function loadJsonlStorage(fs, filePath) {
  const content = getFileSystemResultOrThrow(
    await fs.readTextFile(filePath),
    `Failed to read session ${filePath}`
  );
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length === 0) {
    throw invalidSession(filePath, "missing session header");
  }
  const header = parseHeaderLine(lines[0], filePath);
  const entries = [];
  let leafId = null;
  for (let i = 1; i < lines.length; i++) {
    const entry = parseEntryLine(lines[i], filePath, i + 1);
    entries.push(entry);
    leafId = leafIdAfterEntry(entry);
  }
  return { header, entries, leafId };
}
var JsonlSessionStorage = class _JsonlSessionStorage extends BaseSessionStorage {
  fs;
  filePath;
  constructor(fs, filePath, header, entries, leafId) {
    super(headerToSessionMetadata(header, filePath), entries, leafId);
    this.fs = fs;
    this.filePath = filePath;
  }
  static async open(fs, filePath) {
    const loaded = await loadJsonlStorage(fs, filePath);
    return new _JsonlSessionStorage(fs, filePath, loaded.header, loaded.entries, loaded.leafId);
  }
  /** Create a new JSONL file with a session header and no entries. */
  static async create(fs, filePath, options) {
    const header = {
      type: "session",
      version: 3,
      id: options.sessionId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      cwd: options.cwd,
      parentSession: options.parentSessionPath
    };
    getFileSystemResultOrThrow(
      await fs.writeFile(filePath, `${JSON.stringify(header)}
`),
      `Failed to create session ${filePath}`
    );
    return new _JsonlSessionStorage(fs, filePath, header, [], null);
  }
  async setLeafId(leafId) {
    const entry = this.createLeafEntry(leafId);
    getFileSystemResultOrThrow(
      await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}
`),
      `Failed to append session leaf ${entry.id}`
    );
    this.recordEntry(entry);
  }
  async appendEntry(entry) {
    getFileSystemResultOrThrow(
      await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}
`),
      `Failed to append session entry ${entry.id}`
    );
    this.recordEntry(entry);
  }
};

// vendor/openclaw/packages/agent-core/src/harness/session/jsonl-repo.ts
function encodeCwd(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
var JsonlSessionRepo = class {
  fs;
  sessionsRootInput;
  sessionsRoot;
  constructor(options) {
    this.fs = options.fs;
    this.sessionsRootInput = options.sessionsRoot;
  }
  async getSessionsRoot() {
    if (!this.sessionsRoot) {
      this.sessionsRoot = getFileSystemResultOrThrow(
        await this.fs.absolutePath(this.sessionsRootInput),
        `Failed to resolve sessions root ${this.sessionsRootInput}`
      );
    }
    return this.sessionsRoot;
  }
  async getSessionDir(cwd) {
    return getFileSystemResultOrThrow(
      await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
      `Failed to resolve session directory for ${cwd}`
    );
  }
  async createSessionFilePath(cwd, sessionId, timestamp) {
    return getFileSystemResultOrThrow(
      await this.fs.joinPath([
        await this.getSessionDir(cwd),
        `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`
      ]),
      `Failed to resolve session file path for ${sessionId}`
    );
  }
  async create(options) {
    const id = options.id ?? createSessionId();
    const createdAt = createTimestamp();
    const sessionDir = await this.getSessionDir(options.cwd);
    getFileSystemResultOrThrow(
      await this.fs.createDir(sessionDir, { recursive: true }),
      `Failed to create session directory ${sessionDir}`
    );
    const filePath = await this.createSessionFilePath(options.cwd, id, createdAt);
    const storage = await JsonlSessionStorage.create(this.fs, filePath, {
      cwd: options.cwd,
      sessionId: id,
      parentSessionPath: options.parentSessionPath
    });
    return toSession(storage);
  }
  async open(metadata) {
    if (!getFileSystemResultOrThrow(
      await this.fs.exists(metadata.path),
      `Failed to check session ${metadata.path}`
    )) {
      throw new SessionError("not_found", `Session not found: ${metadata.path}`);
    }
    const storage = await JsonlSessionStorage.open(this.fs, metadata.path);
    return toSession(storage);
  }
  async list(options = {}) {
    const dirs = options.cwd ? [await this.getSessionDir(options.cwd)] : await this.listSessionDirs();
    const sessions = [];
    for (const dir of dirs) {
      if (!getFileSystemResultOrThrow(
        await this.fs.exists(dir),
        `Failed to check session directory ${dir}`
      )) {
        continue;
      }
      const files = getFileSystemResultOrThrow(
        await this.fs.listDir(dir),
        `Failed to list sessions in ${dir}`
      ).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
      for (const file of files) {
        try {
          sessions.push(await loadJsonlSessionMetadata(this.fs, file.path));
        } catch (error) {
          const cause = toError(error);
          if (!(cause instanceof SessionError) || cause.code !== "invalid_session") {
            throw cause;
          }
        }
      }
    }
    sessions.sort(
      (a, b) => (parseSessionTimestampMs(b.createdAt) ?? Number.NEGATIVE_INFINITY) - (parseSessionTimestampMs(a.createdAt) ?? Number.NEGATIVE_INFINITY)
    );
    return sessions;
  }
  async delete(metadata) {
    getFileSystemResultOrThrow(
      await this.fs.remove(metadata.path, { force: true }),
      `Failed to delete session ${metadata.path}`
    );
  }
  async fork(sourceMetadata, options) {
    const source = await this.open(sourceMetadata);
    const forkedEntries = await getEntriesToFork(source.getStorage(), options);
    const id = options.id ?? createSessionId();
    const createdAt = createTimestamp();
    const sessionDir = await this.getSessionDir(options.cwd);
    getFileSystemResultOrThrow(
      await this.fs.createDir(sessionDir, { recursive: true }),
      `Failed to create session directory ${sessionDir}`
    );
    const storage = await JsonlSessionStorage.create(
      this.fs,
      await this.createSessionFilePath(options.cwd, id, createdAt),
      {
        cwd: options.cwd,
        sessionId: id,
        parentSessionPath: options.parentSessionPath ?? sourceMetadata.path
      }
    );
    for (const entry of forkedEntries) {
      await storage.appendEntry(entry);
    }
    return toSession(storage);
  }
  async listSessionDirs() {
    const sessionsRoot = await this.getSessionsRoot();
    if (!getFileSystemResultOrThrow(
      await this.fs.exists(sessionsRoot),
      `Failed to check sessions root ${sessionsRoot}`
    )) {
      return [];
    }
    const entries = getFileSystemResultOrThrow(
      await this.fs.listDir(sessionsRoot),
      `Failed to list sessions root ${sessionsRoot}`
    );
    return entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
  }
};

// vendor/openclaw/packages/agent-core/src/harness/session/memory-storage.ts
var InMemorySessionStorage = class extends BaseSessionStorage {
  constructor(options) {
    super(
      options?.metadata ?? { id: uuidv7(), createdAt: (/* @__PURE__ */ new Date()).toISOString() },
      options?.entries ? [...options.entries] : []
    );
  }
  async setLeafId(leafId) {
    this.recordEntry(this.createLeafEntry(leafId));
  }
  async appendEntry(entry) {
    this.recordEntry(entry);
  }
};

// vendor/openclaw/packages/agent-core/src/harness/session/memory-repo.ts
var InMemorySessionRepo = class {
  sessions = /* @__PURE__ */ new Map();
  async create(options = {}) {
    const metadata = {
      id: options.id ?? createSessionId(),
      createdAt: createTimestamp()
    };
    const storage = new InMemorySessionStorage({ metadata });
    const session = toSession(storage);
    this.sessions.set(metadata.id, session);
    return session;
  }
  async open(metadata) {
    const session = this.sessions.get(metadata.id);
    if (!session) {
      throw new SessionError("not_found", `Session not found: ${metadata.id}`);
    }
    return session;
  }
  async list() {
    return Promise.all([...this.sessions.values()].map((session) => session.getMetadata()));
  }
  async delete(metadata) {
    this.sessions.delete(metadata.id);
  }
  async fork(sourceMetadata, options) {
    const source = await this.open(sourceMetadata);
    const forkedEntries = await getEntriesToFork(source.getStorage(), options);
    const metadata = {
      id: options.id ?? createSessionId(),
      createdAt: createTimestamp()
    };
    const storage = new InMemorySessionStorage({ metadata, entries: forkedEntries });
    const session = toSession(storage);
    this.sessions.set(metadata.id, session);
    return session;
  }
};

// vendor/openclaw/packages/agent-core/src/harness/utils/truncate.ts
var DEFAULT_MAX_LINES = 2e3;
var DEFAULT_MAX_BYTES = 50 * 1024;
var GREP_MAX_LINE_LENGTH = 500;
var runtimeBuffer = globalThis.Buffer;
function splitLinesForCounting(content) {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}
function findFirstNonAscii(content) {
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) > 127) {
      return index;
    }
  }
  return -1;
}
function utf8ByteLength(content) {
  if (runtimeBuffer) {
    return runtimeBuffer.byteLength(content, "utf8");
  }
  const firstNonAscii = findFirstNonAscii(content);
  if (firstNonAscii === -1) {
    return content.length;
  }
  let bytes = firstNonAscii;
  for (let i = firstNonAscii; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code <= 127) {
      bytes += 1;
    } else if (code <= 2047) {
      bytes += 2;
    } else if (code >= 55296 && code <= 56319 && i + 1 < content.length) {
      const next = content.charCodeAt(i + 1);
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
function replaceUnpairedSurrogates(content) {
  let output = "";
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code >= 55296 && code <= 56319) {
      if (i + 1 < content.length) {
        const next = content.charCodeAt(i + 1);
        if (next >= 56320 && next <= 57343) {
          output += content[i] + content[i + 1];
          i++;
          continue;
        }
      }
      output += "\uFFFD";
    } else if (code >= 56320 && code <= 57343) {
      output += "\uFFFD";
    } else {
      output += content[i];
    }
  }
  return output;
}
function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function resolveTruncationInput(content, options) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = utf8ByteLength(content);
  const lines = splitLinesForCounting(content);
  return {
    lines,
    totalLines: lines.length,
    totalBytes,
    maxLines,
    maxBytes
  };
}
function buildTruncationResult(input, params) {
  return {
    content: params.content,
    truncated: params.truncated,
    truncatedBy: params.truncatedBy,
    totalLines: input.totalLines,
    totalBytes: input.totalBytes,
    outputLines: params.outputLines,
    outputBytes: params.outputBytes ?? utf8ByteLength(params.content),
    lastLinePartial: params.lastLinePartial ?? false,
    firstLineExceedsLimit: params.firstLineExceedsLimit ?? false,
    maxLines: input.maxLines,
    maxBytes: input.maxBytes
  };
}
function truncateHead(content, options = {}) {
  const input = resolveTruncationInput(content, options);
  if (input.totalLines <= input.maxLines && input.totalBytes <= input.maxBytes) {
    return buildTruncationResult(input, {
      content,
      truncated: false,
      truncatedBy: null,
      outputLines: input.totalLines,
      outputBytes: input.totalBytes
    });
  }
  const firstLineBytes = utf8ByteLength(input.lines[0]);
  if (firstLineBytes > input.maxBytes) {
    return buildTruncationResult(input, {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true
    });
  }
  const outputLinesArr = [];
  let outputBytesCount = 0;
  let truncatedBy = input.totalLines > input.maxLines ? "lines" : "bytes";
  for (let i = 0; i < input.lines.length && i < input.maxLines; i++) {
    const line = input.lines[i];
    const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > input.maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }
  if (input.totalLines > input.maxLines && outputLinesArr.length >= input.maxLines && outputBytesCount <= input.maxBytes) {
    truncatedBy = "lines";
  }
  const outputContent = outputLinesArr.join("\n");
  return buildTruncationResult(input, {
    content: outputContent,
    truncated: true,
    truncatedBy,
    outputLines: outputLinesArr.length
  });
}
function truncateTail(content, options = {}) {
  const input = resolveTruncationInput(content, options);
  if (input.totalLines <= input.maxLines && input.totalBytes <= input.maxBytes) {
    return buildTruncationResult(input, {
      content,
      truncated: false,
      truncatedBy: null,
      outputLines: input.totalLines,
      outputBytes: input.totalBytes
    });
  }
  const outputLinesArr = [];
  let outputBytesCount = 0;
  let truncatedBy = input.totalLines > input.maxLines ? "lines" : "bytes";
  let lastLinePartial = false;
  for (let i = input.lines.length - 1; i >= 0 && outputLinesArr.length < input.maxLines; i--) {
    const line = input.lines[i];
    const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > input.maxBytes) {
      truncatedBy = "bytes";
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, input.maxBytes);
        outputLinesArr.unshift(truncatedLine);
        outputBytesCount = utf8ByteLength(truncatedLine);
        lastLinePartial = true;
      }
      break;
    }
    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }
  if (input.totalLines > input.maxLines && outputLinesArr.length >= input.maxLines && outputBytesCount <= input.maxBytes) {
    truncatedBy = "lines";
  }
  const outputContent = outputLinesArr.join("\n");
  return buildTruncationResult(input, {
    content: outputContent,
    truncated: true,
    truncatedBy,
    outputLines: outputLinesArr.length,
    lastLinePartial
  });
}
function truncateStringToBytesFromEnd(str, maxBytes) {
  if (maxBytes <= 0) {
    return "";
  }
  let outputBytes = 0;
  let start = str.length;
  let needsReplacement = false;
  for (let i = str.length; i > 0; ) {
    let characterStart = i - 1;
    const code = str.charCodeAt(characterStart);
    let characterBytes;
    let unpairedSurrogate = false;
    if (code >= 56320 && code <= 57343 && characterStart > 0) {
      const previous = str.charCodeAt(characterStart - 1);
      if (previous >= 55296 && previous <= 56319) {
        characterStart--;
        characterBytes = 4;
      } else {
        characterBytes = 3;
        unpairedSurrogate = true;
      }
    } else if (code >= 55296 && code <= 57343) {
      characterBytes = 3;
      unpairedSurrogate = true;
    } else {
      characterBytes = code <= 127 ? 1 : code <= 2047 ? 2 : 3;
    }
    if (outputBytes + characterBytes > maxBytes) {
      break;
    }
    outputBytes += characterBytes;
    start = characterStart;
    needsReplacement ||= unpairedSurrogate;
    i = characterStart;
  }
  const output = str.slice(start);
  return needsReplacement ? replaceUnpairedSurrogates(output) : output;
}
function truncateLine(line, maxChars = GREP_MAX_LINE_LENGTH) {
  if (line.length <= maxChars) {
    return { text: line, wasTruncated: false };
  }
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

// vendor/openclaw/packages/agent-core/src/harness/utils/shell-output.ts
function toExecutionError(error) {
  if (error instanceof ExecutionError) {
    return error;
  }
  const cause = toError(error);
  return new ExecutionError("unknown", cause.message, cause);
}
function sanitizeBinaryOutput(str) {
  return Array.from(str).filter((char) => {
    const code = char.codePointAt(0);
    if (code === void 0) {
      return false;
    }
    if (code === 9 || code === 10 || code === 13) {
      return true;
    }
    if (code <= 31) {
      return false;
    }
    if (code >= 65529 && code <= 65531) {
      return false;
    }
    return true;
  }).join("");
}
async function executeShellWithCapture(env, command, options) {
  const outputChunks = [];
  let outputBytes = 0;
  const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
  const encoder = new TextEncoder();
  let totalBytes = 0;
  let fullOutputPath;
  let writeChain = Promise.resolve(ok(void 0));
  let captureError;
  const appendFullOutput = (text) => {
    if (!fullOutputPath || captureError) {
      return;
    }
    const path = fullOutputPath;
    writeChain = writeChain.then(async (previous) => {
      if (!previous.ok) {
        return previous;
      }
      const appendResult = await env.appendFile(path, text, options?.abortSignal);
      return appendResult.ok ? ok(void 0) : err(toExecutionError(appendResult.error));
    });
  };
  const ensureFullOutputFile = (initialContent) => {
    if (fullOutputPath || captureError) {
      return;
    }
    writeChain = writeChain.then(async (previous) => {
      if (!previous.ok) {
        return previous;
      }
      const tempFile = await env.createTempFile({
        prefix: "bash-",
        suffix: ".log",
        abortSignal: options?.abortSignal
      });
      if (!tempFile.ok) {
        return err(toExecutionError(tempFile.error));
      }
      fullOutputPath = tempFile.value;
      const appendResult = await env.appendFile(
        tempFile.value,
        initialContent,
        options?.abortSignal
      );
      return appendResult.ok ? ok(void 0) : err(toExecutionError(appendResult.error));
    });
  };
  const onChunk = (chunk) => {
    try {
      totalBytes += encoder.encode(chunk).byteLength;
      const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
      if (totalBytes > DEFAULT_MAX_BYTES && !fullOutputPath) {
        ensureFullOutputFile(outputChunks.join("") + text);
      } else {
        appendFullOutput(text);
      }
      outputChunks.push(text);
      outputBytes += text.length;
      while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
        const removed = outputChunks.shift();
        outputBytes -= removed.length;
      }
      options?.onChunk?.(text);
    } catch (error) {
      captureError = toExecutionError(error);
    }
  };
  try {
    const result = await env.exec(command, {
      ...options,
      onStdout: onChunk,
      onStderr: onChunk
    });
    const tailOutput = outputChunks.join("");
    const truncationResult = truncateTail(tailOutput);
    if (truncationResult.truncated && !fullOutputPath) {
      ensureFullOutputFile(tailOutput);
    }
    const writeResult = await writeChain;
    if (!writeResult.ok) {
      return err(writeResult.error);
    }
    if (captureError) {
      return err(captureError);
    }
    if (!result.ok) {
      if (result.error.code === "aborted" || options?.abortSignal?.aborted) {
        return ok({
          output: truncationResult.truncated ? truncationResult.content : tailOutput,
          exitCode: void 0,
          cancelled: true,
          truncated: truncationResult.truncated,
          fullOutputPath
        });
      }
      return err(result.error);
    }
    const cancelled = options?.abortSignal?.aborted ?? false;
    return ok({
      output: truncationResult.truncated ? truncationResult.content : tailOutput,
      exitCode: cancelled ? void 0 : result.value.exitCode,
      cancelled,
      truncated: truncationResult.truncated,
      fullOutputPath
    });
  } catch (error) {
    return err(toExecutionError(error));
  }
}
export {
  Agent,
  CoreAgentHarness as AgentHarness,
  AgentHarnessError,
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  BranchSummaryError,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  CompactionError,
  CoreAgentHarness,
  DEFAULT_COMPACTION_SETTINGS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  ExecutionError,
  FileError,
  GREP_MAX_LINE_LENGTH,
  InMemorySessionRepo,
  InMemorySessionStorage,
  JsonlSessionRepo,
  JsonlSessionStorage,
  NodeExecutionEnv,
  Session,
  SessionError,
  agentLoop,
  agentLoopContinue,
  asAgentMessage,
  bashExecutionToText,
  buildSessionContext,
  calculateContextTokens,
  collectEntriesForBranchSummary,
  collectEntriesForBranchSummaryFromBranches,
  compact,
  convertToLlm,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
  createSessionId,
  createTimestamp,
  err,
  estimateContextTokens,
  estimateTokens,
  executeShellWithCapture,
  findCutPoint,
  findTurnStartIndex,
  formatPromptTemplateInvocation,
  formatSize,
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  generateBranchSummary,
  generateSummary,
  getEntriesToFork,
  getFileSystemResultOrThrow,
  getLastAssistantUsage,
  getOrThrow,
  getOrUndefined,
  killProcessTree,
  loadJsonlSessionMetadata,
  loadPromptTemplates,
  loadSkills,
  loadSourcedPromptTemplates,
  loadSourcedSkills,
  ok,
  parseCommandArgs,
  prepareBranchEntries,
  prepareCompaction,
  resolveAgentCoreCompleteFn,
  resolveAgentCoreStreamFn,
  runAgentLoop,
  runAgentLoopContinue,
  sanitizeBinaryOutput,
  serializeConversation,
  shouldCompact,
  signalProcessTree,
  substituteArgs,
  toError,
  toSession,
  truncateHead,
  truncateLine,
  truncateTail,
  uuidv7,
  validateToolArguments,
  validateToolCall
};
//# sourceMappingURL=agent-core.esm.js.map
