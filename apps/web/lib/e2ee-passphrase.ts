// Short, distinct, easy-to-type words: each adds about 8 bits to a suggested passphrase.
const WORDS =
  `able acid acre agent alarm album alley amber anchor angle apple apron arch arena armor arrow
atlas attic autumn avenue bacon badge bagel baker bamboo banjo barn basil basket beacon beard
berry bicycle biscuit blanket blossom bonfire border bottle bridge broom bucket buffalo bundle
butter cabin cactus camel candle canoe canvas canyon carbon carpet cedar cellar cereal chalk
cherry chess chimney cinema circus citrus clay cliff clover cobalt cocoa comet copper coral
cotton cradle crane crayon cricket crown crystal cumin cushion dagger daisy delta denim desert
diesel dinner dolphin domino donkey dragon drum eagle easel echo eclipse elbow ember engine
fabric falcon feather fender fern ferry fiddle fig flannel flute forest fossil fountain fox
gadget galaxy garden garlic gazebo geyser ginger glacier globe goblet gopher granite gravel
guitar hammer harbor harvest hazel helmet hermit honey hornet hotel igloo index iris island
ivory jacket jaguar jasmine jelly jigsaw jungle kayak kettle kiwi koala ladder lagoon lantern
laptop lemon lilac lily lobster locket lotus lumber magnet mango maple marble meadow melon
meteor mint mirror mitten monsoon mosaic muffin nectar needle nickel noodle nutmeg oasis oat
ocean olive onion opal orbit orchid otter oven paddle pancake panda paper parrot pebble pepper
pickle pigeon pillow pine planet plum pocket pony poppy prism pumpkin puzzle quartz quill rabbit
radar raisin ranch raven reef ribbon river robin rocket saddle saffron salmon sandal satin
scarf schooner shovel signal silver sketch sled slipper sparrow spice spider sponge spruce
squash stable statue summit sunset swan tablet tango teapot thimble thistle thunder tiger
timber toast tomato topaz trail trumpet tulip tundra turnip velvet violet walnut wander willow
window winter yarn zebra zephyr zinc`.split(/\s+/);

/** Five random words: about 40 bits, stretched further by Argon2id. */
export function suggestPassphrase() {
  const words: string[] = [];
  // Values past the last whole multiple of the list are drawn again, so every word is as likely.
  const limit = 65536 - (65536 % WORDS.length);
  while (words.length < 5) {
    const [n] = crypto.getRandomValues(new Uint16Array(1));
    if (n < limit) words.push(WORDS[n % WORDS.length]);
  }
  return words.join('-');
}

/** A rough strength for the meter; the only hard rule is 12 characters. */
export function passphraseStrength(value: string) {
  const words = value.split(/[\s\-_.,]+/).filter((w) => w.length >= 3).length;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((r) => r.test(value)).length;
  const ok = value.length >= 12;
  const level = !ok
    ? 1
    : words >= 4 || value.length >= 20
      ? 4
      : classes >= 3 || value.length >= 16
        ? 3
        : 2;
  const label = !ok
    ? 'Too short · at least 12 characters'
    : level === 4
      ? words >= 4
        ? `Strong · ${words} words`
        : 'Strong'
      : level === 3
        ? 'Good'
        : 'Fair · a few random words are stronger';
  return { ok, level, label };
}
