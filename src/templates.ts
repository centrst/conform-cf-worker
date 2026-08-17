/**
 * Generated install artifacts. These are tested contract surface
 * (install.test.ts) — change templates and their tests together.
 *
 * Accessibility bar for every artifact: every control has an associated
 * label, name/email inputs carry autocomplete attributes, the honeypot is
 * hidden from assistive tech and keyboard order, JS-enhanced variants report
 * outcomes through a polite live region, and nothing signals state by color
 * alone. Artifacts ship as unstyled semantic HTML so they inherit the host
 * site's styling — portable code, no runtime.
 */

export const FRAMEWORKS = ['html', 'js', 'react', 'vue', 'svelte', 'astro', 'nextjs'] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export interface InstallFile {
  path: string;
  content: string;
}

/**
 * Always emitted *after* the real fields. First-field autofill heuristics
 * (Chrome, some password managers) fill a leading text input despite
 * autocomplete="off", and a spam-flagged submission deliberately returns the
 * same 303 + success:true as a real one — so a false positive is invisible:
 * the visitor sees the confirmation and the owner never gets the message.
 */
const HONEYPOT_HTML = `  <div aria-hidden="true" style="position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden;">
    <label for="cf-gotcha">Leave this field empty</label>
    <input id="cf-gotcha" type="text" name="_gotcha" tabindex="-1" autocomplete="off">
  </div>`;

const FIELDS_HTML = `  <p>
    <label for="cf-name">Name</label><br>
    <input id="cf-name" name="name" type="text" autocomplete="name" required>
  </p>
  <p>
    <label for="cf-email">Email</label><br>
    <input id="cf-email" name="email" type="email" autocomplete="email" required>
  </p>
  <p>
    <label for="cf-message">Message</label><br>
    <textarea id="cf-message" name="message" rows="5" required></textarea>
  </p>`;

function htmlTemplate(endpoint: string): string {
  return `<!-- conForm contact form — plain HTML, no JavaScript required.
     Successful posts show a hosted confirmation page; add a hidden
     _redirect field with an https:// URL to return visitors to your site. -->
<form action="${endpoint}" method="post">
${FIELDS_HTML}
${HONEYPOT_HTML}
  <button type="submit">Send message</button>
</form>
`;
}

function jsTemplate(endpoint: string): string {
  return `<!-- conForm contact form with fetch enhancement. Works without JavaScript too. -->
<form id="conform-form" action="${endpoint}" method="post">
${FIELDS_HTML}
${HONEYPOT_HTML}
  <button type="submit">Send message</button>
  <p id="conform-status" role="status" aria-live="polite"></p>
</form>
<script>
  (function () {
    var form = document.getElementById('conform-form');
    var status = document.getElementById('conform-status');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      status.textContent = 'Sending…';
      fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new FormData(form),
      })
        .then(function (response) {
          return response.json().then(function (result) {
            if (response.ok) {
              form.reset();
              status.textContent = 'Thanks — your message was sent.';
            } else {
              status.textContent = result.message || 'Something went wrong. Please try again.';
            }
          });
        })
        .catch(function () {
          status.textContent = 'Network error. Please check your connection and try again.';
        });
    });
  })();
</script>
`;
}

function reactTemplate(endpoint: string): string {
  return `import { useState } from 'react';

// conForm contact form. No client library required — plain fetch.
export default function ContactForm() {
  const [status, setStatus] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    setStatus('Sending…');
    try {
      const response = await fetch('${endpoint}', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new FormData(form),
      });
      const result = await response.json();
      if (response.ok) {
        form.reset();
        setStatus('Thanks — your message was sent.');
      } else {
        setStatus(result.message || 'Something went wrong. Please try again.');
      }
    } catch {
      setStatus('Network error. Please check your connection and try again.');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <p>
        <label htmlFor="cf-name">Name</label><br />
        <input id="cf-name" name="name" type="text" autoComplete="name" required />
      </p>
      <p>
        <label htmlFor="cf-email">Email</label><br />
        <input id="cf-email" name="email" type="email" autoComplete="email" required />
      </p>
      <p>
        <label htmlFor="cf-message">Message</label><br />
        <textarea id="cf-message" name="message" rows={5} required />
      </p>
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
        <label htmlFor="cf-gotcha">Leave this field empty</label>
        <input id="cf-gotcha" type="text" name="_gotcha" tabIndex={-1} autoComplete="off" />
      </div>
      <button type="submit">Send message</button>
      <p role="status" aria-live="polite">{status}</p>
    </form>
  );
}
`;
}

function nextjsTemplate(endpoint: string): string {
  return `'use client';

${reactTemplate(endpoint)}`;
}

function vueTemplate(endpoint: string): string {
  return `<script setup>
import { ref } from 'vue';

// conForm contact form. No client library required — plain fetch.
const status = ref('');

async function handleSubmit(event) {
  const form = event.target;
  status.value = 'Sending…';
  try {
    const response = await fetch('${endpoint}', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new FormData(form),
    });
    const result = await response.json();
    if (response.ok) {
      form.reset();
      status.value = 'Thanks — your message was sent.';
    } else {
      status.value = result.message || 'Something went wrong. Please try again.';
    }
  } catch {
    status.value = 'Network error. Please check your connection and try again.';
  }
}
</script>

<template>
  <form @submit.prevent="handleSubmit">
    <p>
      <label for="cf-name">Name</label><br>
      <input id="cf-name" name="name" type="text" autocomplete="name" required>
    </p>
    <p>
      <label for="cf-email">Email</label><br>
      <input id="cf-email" name="email" type="email" autocomplete="email" required>
    </p>
    <p>
      <label for="cf-message">Message</label><br>
      <textarea id="cf-message" name="message" rows="5" required></textarea>
    </p>
    <div aria-hidden="true" style="position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden;">
      <label for="cf-gotcha">Leave this field empty</label>
      <input id="cf-gotcha" type="text" name="_gotcha" tabindex="-1" autocomplete="off">
    </div>
    <button type="submit">Send message</button>
    <p role="status" aria-live="polite">{{ status }}</p>
  </form>
</template>
`;
}

function svelteTemplate(endpoint: string): string {
  return `<script>
  // conForm contact form. No client library required — plain fetch.
  let status = '';

  async function handleSubmit(event) {
    const form = event.target;
    status = 'Sending…';
    try {
      const response = await fetch('${endpoint}', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new FormData(form),
      });
      const result = await response.json();
      if (response.ok) {
        form.reset();
        status = 'Thanks — your message was sent.';
      } else {
        status = result.message || 'Something went wrong. Please try again.';
      }
    } catch {
      status = 'Network error. Please check your connection and try again.';
    }
  }
</script>

<form on:submit|preventDefault={handleSubmit}>
  <p>
    <label for="cf-name">Name</label><br />
    <input id="cf-name" name="name" type="text" autocomplete="name" required />
  </p>
  <p>
    <label for="cf-email">Email</label><br />
    <input id="cf-email" name="email" type="email" autocomplete="email" required />
  </p>
  <p>
    <label for="cf-message">Message</label><br />
    <textarea id="cf-message" name="message" rows="5" required></textarea>
  </p>
  <div aria-hidden="true" style="position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden;">
    <label for="cf-gotcha">Leave this field empty</label>
    <input id="cf-gotcha" type="text" name="_gotcha" tabindex="-1" autocomplete="off" />
  </div>
  <button type="submit">Send message</button>
  <p role="status" aria-live="polite">{status}</p>
</form>
`;
}

function astroTemplate(endpoint: string): string {
  return `---
// conForm contact form. Static HTML with a small enhancement script;
// works without JavaScript too.
---

<form id="conform-form" action="${endpoint}" method="post">
${FIELDS_HTML}
${HONEYPOT_HTML}
  <button type="submit">Send message</button>
  <p id="conform-status" role="status" aria-live="polite"></p>
</form>

<script>
  const form = document.getElementById('conform-form');
  const status = document.getElementById('conform-status');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!(form instanceof HTMLFormElement) || !status) return;
    status.textContent = 'Sending…';
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new FormData(form),
      });
      const result = await response.json();
      if (response.ok) {
        form.reset();
        status.textContent = 'Thanks — your message was sent.';
      } else {
        status.textContent = result.message || 'Something went wrong. Please try again.';
      }
    } catch {
      status.textContent = 'Network error. Please check your connection and try again.';
    }
  });
</script>
`;
}

const FILE_NAMES: Record<Framework, string> = {
  html: 'contact-form.html',
  js: 'contact-form.html',
  react: 'ContactForm.jsx',
  vue: 'ContactForm.vue',
  svelte: 'ContactForm.svelte',
  astro: 'ContactForm.astro',
  nextjs: 'ContactForm.jsx',
};

const BUILDERS: Record<Framework, (endpoint: string) => string> = {
  html: htmlTemplate,
  js: jsTemplate,
  react: reactTemplate,
  vue: vueTemplate,
  svelte: svelteTemplate,
  astro: astroTemplate,
  nextjs: nextjsTemplate,
};

export function isFramework(value: string): value is Framework {
  return (FRAMEWORKS as readonly string[]).includes(value);
}

export function installFiles(framework: Framework, endpoint: string): InstallFile[] {
  return [{ path: FILE_NAMES[framework], content: BUILDERS[framework](endpoint) }];
}

export function installNotes(framework: Framework): string[] {
  const notes = [
    'Submissions deliver only after the destination inbox is verified — poll the status URL until status is "active". The endpoint URL will not change.',
    'The hidden _gotcha field is a spam trap. Keep it in the form and never fill it.',
    'Verify delivery with a marked test: add _test=true to a submission; the response returns test: true as proof and the email arrives with a [Test] subject.',
  ];
  if (framework === 'html') {
    notes.push(
      'Add a hidden _redirect input with an absolute https:// URL to return visitors to your own thank-you page after delivery.',
    );
  }
  return notes;
}

export function testCommand(endpoint: string): string {
  return `curl -sS -X POST ${endpoint} -d 'name=Test&email=test@example.com&message=Hello from a test&_test=true'`;
}
