// Types of messages.mjs, for the demo (site/demo) and the tests.

/** AMQP properties as a publisher sets them (amqplib's publish options). */
export interface ScenarioProperties {
  messageId: string;
  contentType: string;
  correlationId?: string;
  /** Seconds since the epoch. */
  timestamp?: number;
  type?: string;
  appId?: string;
  deliveryMode: number;
  headers?: Record<string, string>;
}

/** One Message of the screenshot scenario, as its publisher sends it. */
export interface ScenarioMessage {
  exchange: string;
  routingKey: string;
  content: Uint8Array;
  properties: ScenarioProperties;
}

export function scenarioMessages(): ScenarioMessage[];
