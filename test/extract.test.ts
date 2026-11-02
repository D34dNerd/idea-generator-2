import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asUrl, decodeEntities, htmlToText } from '../server/extract.ts';

test('recognises a lone link, with or without scheme', () => {
  assert.equal(asUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(asUrl('  www.example.se/artikel '), 'https://www.example.se/artikel');
  assert.equal(asUrl('elcyklar i glesbygd'), null);
  assert.equal(asUrl('läs https://example.com'), null, 'text with a link in it is text');
  assert.equal(asUrl('javascript:alert(1)'), null);
  assert.equal(asUrl('ftp://example.com'), null);
});

test('decodes named and numeric entities, including Swedish letters', () => {
  assert.equal(decodeEntities('R&auml;ksm&ouml;rg&aring;s &amp; &#229;&#xE4; &hellip;'), 'Räksmörgås & åä …');
  assert.equal(decodeEntities('&bogus; &#0;'), '&bogus; &#0;');
});

test('extracts the article and drops scripts, navigation and footers', () => {
  const html = `<!doctype html><html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="Cykelbibliotek i Växjö">
    <style>.x{color:red}</style><script>var secret = 1;</script></head>
    <body><nav>Meny Hem Om</nav>
    <article><h1>Cykelbibliotek</h1><p>Kommunen l&aring;nar ut <b>lastcyklar</b>.</p>
    <script>tracking()</script><p>Andra stycket.<br>Ny rad.</p></article>
    <footer>© 2026</footer></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, 'Cykelbibliotek i Växjö');
  assert.match(text, /^Cykelbibliotek\n\nKommunen lånar ut lastcyklar \./);
  assert.match(text, /Andra stycket\.\nNy rad\./);
  for (const junk of ['secret', 'tracking', 'Meny', '©', 'color:red']) assert.ok(!text.includes(junk), junk);
});

test('falls back to <title> and <body> when there is no article', () => {
  const { title, text } = htmlToText('<title>T &amp; T</title><body><div>Hej</div><div>då</div></body>');
  assert.equal(title, 'T & T');
  assert.equal(text, 'Hej\n\ndå');
});

test('caps very long pages', () => {
  const { text } = htmlToText(`<body><p>${'ord '.repeat(5000)}</p></body>`);
  assert.ok(text.length <= 6000 + 4);
  assert.ok(text.endsWith('[…]'));
});
