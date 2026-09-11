// Metadata names and derivative ancestry mirror a bounded public metadata inspection.
// All guide prose is invented test material, not a transcription of the archived book.
export const gamingArchiveGuideUrl = 'https://archive.org/details/KH1.5_guide';
export const gamingArchiveStorageHost = 'ia601801.us.archive.org';
export const gamingArchiveDerivativePath = '/4/items/KH1.5_guide/001%20Combine_djvu.txt';
export const gamingArchiveGuideText = [
  'Kingdom Hearts HD 1.5 Remix beginner guide: the lantern checkpoint route.',
  'Before the first boss encounter, Sora should prepare healing items, equip a suitable weapon, and save at the lantern checkpoint. Follow the western path to the courtyard, practice guarding against the opening attack, and wait for the recovery window before striking. This route keeps enough health available for the second combat phase.',
  'For Kingdom Hearts HD 1.5 Remix progression, explore the courtyard before entering the next room. Collect the blue marker and return to the lantern checkpoint to save progress. After the boss finishes its sweeping attack, move to the left side and use a short attack combination. Stop attacking when the guard animation begins and restore health before the next phase.',
  'This Kingdom Hearts HD 1.5 Remix walkthrough recommends checking equipment at every checkpoint. Review available abilities before leaving the courtyard, keep a healing item assigned to a shortcut, and learn the safe timing for dodging each attack. Follow the blue marker toward the upper gate only after saving and confirming the required items are available.',
  'The lantern checkpoint strategy is synthetic regression evidence. The fixture describes a sequence of preparation, guarding, healing, saving, and route selection so tests can verify that readable guide paragraphs reach the provider context instead of Archive navigation text.'
].join('\n\n');

export function gamingArchiveMetadata(text = gamingArchiveGuideText): Record<string, any> {
  return {
    metadata: { identifier: 'KH1.5_guide', mediatype: 'texts', title: 'Kingdom Hearts HD 1.5 Remix guide' },
    d1: gamingArchiveStorageHost,
    d2: 'ia801801.us.archive.org',
    dir: '/4/items/KH1.5_guide',
    files: [
      { name: '001 Combine.pdf', format: 'Image Container PDF', source: 'original', size: '292063495' },
      { name: '001 Combine_jp2.zip', format: 'Single Page Processed JP2 ZIP', source: 'derivative', original: '001 Combine.pdf', size: '226024052' },
      { name: '001 Combine_chocr.html.gz', format: 'chOCR', source: 'derivative', original: '001 Combine_jp2.zip', size: '9940004' },
      { name: '001 Combine_hocr.html', format: 'hOCR', source: 'derivative', original: '001 Combine_chocr.html.gz', size: '21164134' },
      { name: '001 Combine_djvu.xml', format: 'Djvu XML', source: 'derivative', original: '001 Combine_hocr.html', size: '10901662' },
      { name: '001 Combine_djvu.txt', format: 'DjVuTXT', source: 'derivative', original: '001 Combine_djvu.xml', size: String(Buffer.byteLength(text, 'utf8')) },
      { name: 'KH1.5_guide_meta.xml', format: 'Metadata', source: 'original', size: '1946' },
      { name: 'README.txt', format: 'Text', source: 'original', size: '100' }
    ]
  };
}

export const gamingArchiveLandingHtml = '<!doctype html><html><head><title>Internet Archive</title></head><body><nav>'
  + 'Internet Archive Search Upload Sign In Account Menu Privacy Terms Subscribe '.repeat(60)
  + '</nav><main>Kingdom Hearts HD 1.5 Remix. Identifier KH1.5_guide. Addeddate. Reviews. Download Options.</main></body></html>';
