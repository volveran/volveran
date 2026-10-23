// Integration test harness. Integration tests drive Volverán's HTTP API
// against the docker-compose test broker and check the broker independently.
//
// The broker helpers live in test/broker/client.ts (shared with the
// broker-facts suite). The in-process app (startApp, testProfile) arrives
// with the server in #2.
export * from '../broker/client.js';
