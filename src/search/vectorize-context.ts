import { Context, Option } from "effect";
import type { AiBinding, VectorizeBinding } from "./vectorize.js";

export class VectorizeContext extends Context.Service<
  VectorizeContext,
  Option.Option<{ ai: AiBinding; vectorize: VectorizeBinding }>
>()("VectorizeContext") {}
