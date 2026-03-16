import { Context, Option } from "effect";
import type { AiBinding, VectorizeBinding } from "./vectorize.js";

export class VectorizeContext extends Context.Tag("VectorizeContext")<
  VectorizeContext,
  Option.Option<{ ai: AiBinding; vectorize: VectorizeBinding }>
>() {}
