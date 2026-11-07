// The demo's banner above the web app: the release's version, that nothing
// touches a real broker, and Reset demo. Narrow screens also get a notice they
// can dismiss (for this page only: nothing is stored). If the demo cannot
// start, the banner says why (showStartFailure).
import './banner.css';

declare const __VOLVERAN_RELEASE__: string;

const banner = document.getElementById('demo-banner')!;
banner.querySelector('.demo-version')!.textContent = `Volverán ${__VOLVERAN_RELEASE__}`;

// A load of the page without its view in the address: the starting scenario, on the queue list.
banner.querySelector('.demo-reset')!.addEventListener('click', () => location.replace(location.pathname));

const notice = document.getElementById('demo-desktop-notice')!;
const narrow = window.matchMedia('(max-width: 899px)');
const showNotice = () => {
  notice.hidden = !narrow.matches || notice.dataset.dismissed === 'true';
};
notice.querySelector('button')!.addEventListener('click', () => {
  notice.dataset.dismissed = 'true';
  showNotice();
});
narrow.addEventListener('change', showNotice);
showNotice();

/** Says in the banner that the demo did not start, and why; the web app is not loaded. */
export function showStartFailure(error: unknown): void {
  const message = document.createElement('p');
  message.className = 'demo-start-failure';
  message.setAttribute('role', 'alert');
  const reason = error instanceof Error ? error.message : String(error);
  message.textContent = `The demo has not started: it could not load its recording. Reload the page to try again. (${reason})`;
  banner.append(message);
}
