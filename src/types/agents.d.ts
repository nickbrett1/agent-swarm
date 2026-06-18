import { Agent, type CallableMetadata } from "agents";

declare module "agents" {
  /**
   * Override callable to support experimentalDecorators: true
   */
  export function callable(metadata?: CallableMetadata): any;
}
