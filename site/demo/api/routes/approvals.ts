// Approval (Team Mode only, ADR 0002): in Solo Mode the web app never asks
// for one, so every Approval route, and a Checkout's request for one, answers
// 404 `not_in_demo` saying why.
import type { Method, Router } from '../router.js';

const MESSAGE = 'Not in the demo: Approval needs Team Mode.';

const ROUTES: Array<[Method, string]> = [
  ['GET', '/approvals'],
  ['GET', '/approvals/{checkoutId}'],
  ['GET', '/approvals/{checkoutId}/messages/{handle}'],
  ['GET', '/approvals/{checkoutId}/compare'],
  ['POST', '/approvals/{checkoutId}/approve'],
  ['POST', '/approvals/{checkoutId}/reject'],
  ['POST', '/approvals/{checkoutId}/apply/stop'],
  ['POST', '/approvals/{checkoutId}/apply/continue'],
  ['POST', '/checkouts/{id}/approval-request'],
  ['DELETE', '/checkouts/{id}/approval-request'],
];

export function registerApprovalRoutes(router: Router) {
  for (const [method, template] of ROUTES) router.notInDemo(method, template, MESSAGE);
}
