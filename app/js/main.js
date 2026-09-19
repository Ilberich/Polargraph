/**
 * Application entry point.
 *
 * Phase 0 boots the shell and reports what this origin is capable of. The
 * design tool itself arrives in Phase 2.
 */

import { describeEnvironment, plotterUrl } from './core/env.js';
import {
  MM_PER_REV,
  STEPS_PER_REV,
  MM_PER_STEP,
  STEPS_PER_MM,
} from './core/machine.js';

export function renderModeBadge(env) {
  const badge = document.getElementById('mode-badge');
  const label = document.getElementById('mode-label');

  const connected = env.canReachPlotter;

  badge.classList.toggle('badge--connected', connected);
  badge.classList.toggle('badge--standalone', !connected);

  // "Machine control" rather than "connected": this says the origin permits a
  // connection, not that a plotter has answered. Actual reachability is a
  // Phase 5 concern.
  label.textContent = connected ? 'Machine control' : 'Standalone';
}

export function renderEnvironmentNotice(env) {
  if (env.canReachPlotter) return;

  const url = plotterUrl();
  const notice = document.getElementById('env-notice');

  notice.className = 'notice notice--info';
  notice.hidden = false;
  notice.innerHTML = `
    <strong class="notice__title">Design tool only</strong>
    <span>${env.reason}</span>
    <span>Your plotter: <a href="${url}">${url}</a></span>
  `;
}

export function renderMachineSpecs() {
  const specs = [
    ['Travel per rev', `${MM_PER_REV} mm`],
    ['Steps per rev', String(STEPS_PER_REV)],
    ['Steps per mm', String(STEPS_PER_MM)],
    ['Resolution', `${MM_PER_STEP} mm`],
  ];

  document.getElementById('machine-specs').innerHTML = specs
    .map(
      ([key, value]) => `
        <dt class="spec__key">${key}</dt>
        <dd class="spec__value">${value}</dd>`
    )
    .join('');
}

function main() {
  const env = describeEnvironment(window.location);

  renderModeBadge(env);
  renderEnvironmentNotice(env);
  renderMachineSpecs();
}

main();
