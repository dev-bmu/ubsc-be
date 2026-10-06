import sanitizeHtml from 'sanitize-html'

// ===== Sanitasi HTML isi artikel (editor WYSIWYG admin) =====
// Isi artikel dirender landing lewat dangerouslySetInnerHTML, jadi server yang menjadi pagar XSS:
// disanitasi saat TULIS (store/update) dan sekali lagi saat BACA publik (baris lama/seed yang belum
// pernah lewat jalur tulis). Daftar putih, bukan daftar hitam — apa pun di luar daftar di bawah dibuang
// (teksnya tetap, kecuali isi <script>/<style> yang dibuang utuh).

const ALIGNABLE = ['p', 'h2', 'h3', 'h4'] as const

const ARTICLE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'h2',
    'h3',
    'h4',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'code',
    'pre',
    'hr',
    'img',
    'figure',
    'figcaption'
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    ...Object.fromEntries(ALIGNABLE.map((tag) => [tag, ['style']]))
  },
  // Hanya text-align (TextAlign TipTap menulis style="text-align: center"); properti lain dibuang.
  allowedStyles: Object.fromEntries(ALIGNABLE.map((tag) => [tag, { 'text-align': [/^(left|right|center|justify)$/] }])),
  // URL relatif ('/uploads/...') tetap lolos — sanitize-html hanya memeriksa skema bila ada.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  transformTags: {
    // Satu <h1> per halaman milik judul artikel; heading isi dimulai dari h2.
    h1: 'h2',
    h5: 'h4',
    h6: 'h4',
    a: (tagName, attribs) => {
      const { target, ...rest } = attribs
      return target === '_blank' ? { tagName, attribs: { ...rest, target, rel: 'noopener noreferrer' } } : { tagName, attribs: rest }
    }
  },
  // <img> yang src-nya dibuang (data:, javascript:) tidak menyisakan tag kosong.
  exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src
}

export function sanitizeArticleHtml(html: string): string {
  return sanitizeHtml(html, ARTICLE_OPTIONS).trim()
}

/**
 * Teks polos dari HTML (deskripsi SEO, hitung kata). Penutup blok diberi spasi dulu supaya
 * '<p>a</p><p>b</p>' menjadi 'a b', bukan 'ab'; entitas yang di-escape ulang sanitize-html dikembalikan.
 */
export function htmlToText(html: string): string {
  const spaced = html.replace(/<(?:br|hr|\/(?:p|h[1-6]|li|blockquote|pre|figcaption|div))\b[^>]*>/gi, '$& ')
  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
