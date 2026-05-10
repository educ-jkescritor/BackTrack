"use client";

import { useEffect } from "react";
import "./Walkthrough.css";

// ──────────────────────────────────────────────────────────────────────────────
// Step configuration per route / context.
//
// Dashboard sequence (/) follows the required order:
//   1. Container Health
//   2. Recent Deployment
//   3. Anomaly Detection
//   4. Active Containers
//   5. Recent Rollbacks
//
// When the Configure Cluster modal is open the engine switches to the
// '/config-modal' flow automatically (detected by DOM presence of the
// #wt-config-modal element).
// ──────────────────────────────────────────────────────────────────────────────
const stepsConfig: Record<string, { element: string; title: string; text: string }[]> = {
  '/': [
    {
      element: "#wt-health-dashboard",
      title: "Container Health Overview",
      text: "Visualizes cluster health and container metrics in a highly organized and intuitive layout. Provides a complete view of your containerized workloads including CPU, memory, and uptime trends."
    },
    {
      element: "#wt-recent-deployment",
      title: "Recent Deployment & Rollback Status",
      text: "Triggers successfully whenever a predefined anomaly threshold is exceeded. Executes the rollback process, minimizing downtime by restoring the application to its last known stable state."
    },
    {
      element: "#wt-anomaly-detection",
      title: "Anomaly Detection Module",
      text: "Background anomaly detection algorithms process high volumes of data without causing significant resource overhead. Uses TSD and LSI to identify deviations from normal baselines."
    },
    {
      element: "#wt-active-containers",
      title: "Explainable Insights & Active Containers",
      text: "Provides explainable insights detailing the semantic or metric cause of each rollback, and simplifies complex system management tasks for active containers."
    },
    {
      element: "#wt-recent-rollbacks",
      title: "Recent Rollbacks",
      text: "Logs the automated CI/CD rollback events that are triggered by the system's anomaly detection to ensure minimal downtime and rapid recovery."
    }
  ],
  '/anomalies': [
    {
      element: "#wt-terminal-panel",
      title: "Integrated Terminal",
      text: "Provides real-time kubectl access to your cluster, allowing manual investigation and complex system management tasks without leaving the dashboard."
    },
    {
      element: "#wt-tsd-panel",
      title: "Time Series Decomposition (TSD)",
      text: "Continuously analyzes quantitative metrics (CPU, memory, latency, error rate) to establish baselines and detect sudden drifts or spikes indicating anomalies."
    },
    {
      element: "#wt-lsi-panel",
      title: "Latent Semantic Indexing (LSI)",
      text: "Analyzes textual log streams in real-time, detecting novel error patterns and semantic shifts to provide explainable insights into application failures."
    }
  ],
  '/metrics': [
    {
      element: "#wt-mttr-section",
      title: "Mean Time to Recovery (MTTR)",
      text: "Tracks the performance efficiency of the system by measuring the exact time taken from anomaly detection to the successful completion of an automated rollback."
    },
    {
      element: "#wt-matrix-section",
      title: "Detection Accuracy (ISO 25010)",
      text: "Evaluates functional suitability by computing a Confusion Matrix (Precision, Recall, F1-Score) based on intentional fault injections and system responses."
    }
  ],
  '/config-modal': [
    {
      element: "#wt-config-modal",
      title: "Configure Cluster Connection",
      text: "This interface allows you to connect a target environment. You will be guided to enter your application name, select the target platform, provide cluster credentials (like a Kubeconfig path), and establish the telemetry stream."
    }
  ]
};

export default function Walkthrough() {
  useEffect(() => {
    let isActive = false;
    let stepIndex = -1;
    let currentFlow: { element: string; title: string; text: string }[] = [];

    // ── Determine which step flow is active ──────────────────────────────────
    function updateCurrentFlow() {
      const path = window.location.pathname;
      // If the Configure Cluster modal is open, override to modal flow
      if (document.getElementById('wt-config-modal')) {
        currentFlow = stepsConfig['/config-modal'];
      } else {
        if (path === '/' || path === '') currentFlow = stepsConfig['/'];
        else if (path.includes('/anomalies')) currentFlow = stepsConfig['/anomalies'];
        else if (path.includes('/metrics')) currentFlow = stepsConfig['/metrics'];
        else currentFlow = [];
      }
    }

    const body = document.body;

    // ── Inject spotlight overlay ─────────────────────────────────────────────
    const spotlight = document.createElement('div');
    spotlight.id = 'wt-spotlight';
    body.appendChild(spotlight);

    // ── Inject explainer card ────────────────────────────────────────────────
    const card = document.createElement('div');
    card.id = 'wt-card';
    card.innerHTML = `
      <div class="wt-title">
        <span id="wt-step-title"></span>
        <span id="wt-step-count" style="opacity:0.5">1/${currentFlow.length}</span>
      </div>
      <div class="wt-text" id="wt-step-text"></div>
      <div class="wt-progress" id="wt-dots"></div>
      <div class="wt-hint">PRESS [SPACE] TO CONTINUE</div>
    `;
    body.appendChild(card);

    // ── Smart card positioning ───────────────────────────────────────────────
    function positionCard(targetRect: DOMRect) {
      const cardWidth = 320;
      const cardHeight = card.offsetHeight || 200;
      const gap = 20;
      const padding = 20;

      let cardTop: number, cardLeft: number;
      let position = 'below';

      if (targetRect.bottom + gap + cardHeight + padding < window.innerHeight) {
        cardTop = targetRect.bottom + gap;
        cardLeft = targetRect.left;
        position = 'below';
      } else if (targetRect.top - gap - cardHeight - padding > 0) {
        cardTop = targetRect.top - gap - cardHeight;
        cardLeft = targetRect.left;
        position = 'above';
      } else if (targetRect.right + gap + cardWidth + padding < window.innerWidth) {
        cardTop = targetRect.top;
        cardLeft = targetRect.right + gap;
        position = 'right';
      } else if (targetRect.left - gap - cardWidth - padding > 0) {
        cardTop = targetRect.top;
        cardLeft = targetRect.left - gap - cardWidth;
        position = 'left';
      } else {
        cardTop = (window.innerHeight - cardHeight) / 2;
        cardLeft = (window.innerWidth - cardWidth) / 2;
        position = 'center';
      }

      // Clamp horizontal position
      if (position === 'below' || position === 'above') {
        if (cardLeft + cardWidth > window.innerWidth - padding) {
          cardLeft = window.innerWidth - cardWidth - padding;
        }
        if (cardLeft < padding) {
          cardLeft = padding;
        }
      }

      // Clamp vertical position
      if (position === 'right' || position === 'left') {
        if (cardTop + cardHeight > window.innerHeight - padding) {
          cardTop = window.innerHeight - cardHeight - padding;
        }
        if (cardTop < padding) {
          cardTop = padding;
        }
      }

      return { top: cardTop, left: cardLeft };
    }

    // ── Render a step ────────────────────────────────────────────────────────
    function renderStep(index: number) {
      if (index >= currentFlow.length) {
        endWalkthrough();
        return;
      }

      const step = currentFlow[index];
      const target = document.querySelector(step.element);

      if (!target) {
        console.warn('[Walkthrough] Target not found:', step.element);
        renderStep(index + 1);
        return;
      }

      // Ensure the target is fully visible before measuring bounds
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Give scroll a moment to settle before measuring (sync with modal transition)
      setTimeout(() => {
        if (!isActive) return;
        const rect = target.getBoundingClientRect();

        const spotlightPadding = 8;
        spotlight.style.width = `${rect.width + (spotlightPadding * 2)}px`;
        spotlight.style.height = `${rect.height + (spotlightPadding * 2)}px`;
        spotlight.style.top = `${rect.top - spotlightPadding}px`;
        spotlight.style.left = `${rect.left - spotlightPadding}px`;
        spotlight.style.opacity = '1';

        (document.getElementById('wt-step-title') as HTMLElement).innerText = step.title;
        (document.getElementById('wt-step-text') as HTMLElement).innerText = step.text;
        (document.getElementById('wt-step-count') as HTMLElement).innerText = `${index + 1}/${currentFlow.length}`;

        // Rebuild progress dots
        const dotsContainer = document.getElementById('wt-dots') as HTMLElement;
        dotsContainer.innerHTML = '';
        currentFlow.forEach((_, i) => {
          const dot = document.createElement('div');
          dot.className = `wt-dot ${i === index ? 'active' : ''}`;
          dotsContainer.appendChild(dot);
        });

        // Position card after DOM is updated
        requestAnimationFrame(() => {
          const cardPos = positionCard(rect);
          card.style.top = `${cardPos.top}px`;
          card.style.left = `${cardPos.left}px`;
          card.style.opacity = '1';
        });
      }, 150);
    }

    // ── Start walkthrough ────────────────────────────────────────────────────
    function startWalkthrough() {
      updateCurrentFlow();
      if (!currentFlow || currentFlow.length === 0) return;

      stepIndex = 0;

      if (!isActive) {
        isActive = true;
        // Inject dark overlay
        const overlay = document.createElement('div');
        overlay.id = 'wt-overlay';
        body.appendChild(overlay);
        setTimeout(() => { overlay.style.opacity = '1'; }, 50);
      }

      renderStep(stepIndex);
    }

    // ── Advance to next step ─────────────────────────────────────────────────
    function nextStep() {
      if (!isActive) return;

      const oldFlow = currentFlow;
      updateCurrentFlow();

      // If the modal just opened/closed, restart from step 0 for new flow
      if (oldFlow !== currentFlow) {
        stepIndex = 0;
      } else {
        stepIndex++;
      }

      renderStep(stepIndex);
    }

    // ── End walkthrough ──────────────────────────────────────────────────────
    function endWalkthrough() {
      isActive = false;
      spotlight.style.opacity = '0';
      card.style.opacity = '0';
      const overlay = document.getElementById('wt-overlay');
      if (overlay) {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 500);
      }
      setTimeout(() => {
        spotlight.style.width = '0';
        spotlight.style.height = '0';
      }, 500);
    }

    // ── Keyboard handler ─────────────────────────────────────────────────────
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowRight') {
        e.preventDefault();
        if (!isActive) startWalkthrough();
        else nextStep();
      }
      if (e.code === 'Escape') {
        endWalkthrough();
      }
    };

    // ── Custom event: programmatic start ────────────────────────────────────
    const startEvent = () => {
      startWalkthrough();
    };

    // ── Route-change detection (Next.js client-side navigation) ─────────────
    // Intercept pushState / replaceState to detect Next.js soft navigation,
    // then fire a custom event that resets the demo session.
    let _lastPath = window.location.pathname;

    const onRouteChange = () => {
      const newPath = window.location.pathname;
      if (newPath !== _lastPath) {
        _lastPath = newPath;
        // End any active demo session so SPACE starts fresh on the new page
        endWalkthrough();
        stepIndex = -1;
        currentFlow = [];
      }
    };

    // Patch history methods — Next.js uses these for client-side transitions
    const _origPush    = history.pushState.bind(history);
    const _origReplace = history.replaceState.bind(history);
    history.pushState = (...args) => { _origPush(...args);    onRouteChange(); };
    history.replaceState = (...args) => { _origReplace(...args); onRouteChange(); };
    window.addEventListener('popstate', onRouteChange);

    document.addEventListener('keydown', keydownHandler);
    window.addEventListener('backtrack:start-walkthrough', startEvent);
    console.log('[BackTrack] Walkthrough loaded. Press SPACE or → to start, ESC to exit.');

    // ── Cleanup on unmount ───────────────────────────────────────────────────
    return () => {
      document.removeEventListener('keydown', keydownHandler);
      window.removeEventListener('backtrack:start-walkthrough', startEvent);
      window.removeEventListener('popstate', onRouteChange);
      // Restore original history methods
      history.pushState    = _origPush;
      history.replaceState = _origReplace;
      spotlight.remove();
      card.remove();
      const overlay = document.getElementById('wt-overlay');
      if (overlay) overlay.remove();
    };
  }, []);

  // This component renders nothing — it only manages DOM imperative overlays
  return null;
}
