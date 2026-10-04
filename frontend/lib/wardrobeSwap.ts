/**
 * The user-facing wardrobe node has no prompt. This internal contract assigns an
 * unambiguous role to each reference so the second image cannot replace the person.
 */
export function buildWardrobeSwapPrompt(detail = ''): string {
  const adjustment = detail.trim();
  return [
    '<图1> is the immutable master image. Preserve its exact person identity, face, expression, hair, body shape, pose, hands, accessories, props, background, lighting, camera, framing, composition, and illustration or photographic style.',
    'Replace only the clothing worn by the person in <图1> with the complete outfit from <图2>. Transfer only garment design, layers, fabric, color, texture, folds, trim, footwear, and clothing accessories from <图2>. Fit that outfit naturally to the unchanged body and pose in <图1>.',
    'Do not transfer the person, face, hair, skin, body, pose, background, lighting, camera, or art style from <图2>. Do not move, crop, redesign, or add anything outside the clothing area. Output one finished still image, never a before-and-after layout.',
    adjustment ? `Additional wardrobe adjustment: ${adjustment}` : '',
  ].filter(Boolean).join(' ');
}
