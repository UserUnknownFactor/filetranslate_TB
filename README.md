# filetranslate TyranoBuilder plugin

A text and image translation plugin for TyranoBuilder/TyranoScript that enables multi-language support for your game projects.

## Features

- Support for complex text with tags
- Automatic word wrapping to fit translated text in the dialog window
- Image replacement based on the selected language
- Character name translations
- Tag/eval parameter translations
- URL language parameter support (`?lang=en`)
- In-game language switching capability

## Installation

1. Copy the plugin code to `app/tyrano/plugins/_filetranslate_TB.js` in your TyranoBuilder project;
2. Translate `app/tyrano/langs.js`;
2. Register the plugin in `app/index.html` as `<script type="text/javascript" src="./tyrano/plugins/_filetranslate_TB.js" ></script>` after all other plugins.
3. Create a `TranslationConfig.json` file in your project's `data/system/` directory with the following structure:  
```json
{
  "enabled": true,
  "debug": false,
  "image_folders": ["title", "config"],
  "translation_folder": "translated",
  "current_language": "",
  "width": 950
}
```

### Configuration Options

- `enabled`: Enable or disable the translation plugin
- `debug`: Show debug messages in the console
- `image_folders`: Folders to check for translated images
- `translation_folder`: Folder containing translation files
- `current_language`: Default language (empty for original language)
- `width`: Maximum width of the text for text wrapping (0 disables it)

## Usage

### Creating Translation Files

For each scenario file (e.g., `scene1.ks`), you can create two CSV files in the same location:
- `scene1_strings_fr.csv` for text translations
- `scene1_attributes_fr.csv` for tag attributes and eval translations

Additionally, create a `characters[_fr].csv` file for character name translations.

Attribute files are dictionaries of sentence/word translations, they contain one and only one possible translation, which can be referred to multiple times in the scenario, like character names.
String files are lists of consequent translations, where the same sentence can have multiple translations depending on its position in the list. Both files support context information in the third column, but in my translation practice I've never experienced a situation where the context is useful, so it's ignored and can be used simply as a hint for the translator.

Without the `_fr` part, it's considered a default/unset translation (English). 
If no translation data is found, default game strings and images are used.

### DSV Format
```
Original text→Translated text
Original text 1→Translated text 1→Context
```
Special characters:
- `¶` for escaping (`\n`, `¶`, `→` characters)
- `→` as separator between original text, translated text and optional context

### Translating Images

Place translated images in a `translated[_language]` subfolder within your image directories.

For example, if your original image is at `data/fgimage/character.png`, the French version would be at `data/fgimage/translated_fr/character.png`.


## Advanced Features

### Changing Language

Add a language parameter to your URL to change the language:
```
yourgame.com/index.html?lang=en
```

Or use the `switchLanguage` method in a script:
```javascript
tyrano.plugin.kag.translator.switchLanguage("en");
```

### Word Wrapping

The plugin automatically handles word wrapping for translated text, adjusting based on:
- Font family and size
- Game window width
- Language-specific rules (e.g., Japanese/Chinese character handling)

Word wrapping is disabled if `width' is set to 0 in the configuration.

### Language Switching Tag

#### Usage

```
[switch_language lang="fr"]
```

#### Parameters

- `lang`: The language code to switch to (e.g., "en", "fr", "jp", etc.)

#### Example

Here's an example of creating a language selection menu:

```
[macro name="language_menu"]
[layopt layer="message" visible="false"]
[clearfix]
[cm]

[image storage="language_bg.png" layer="base"]

[button x="100" y="200" graphic="lang_en.png" target="*switch_to_english"]
[button x="300" y="200" graphic="lang_jp.png" target="*switch_to_japanese"]
[button x="500" y="200" graphic="lang_fr.png" target="*switch_to_french"]

[s]

*switch_to_english
[switch_language lang=""]
[jump storage="title.ks"]

*switch_to_japanese
[switch_language lang="jp"]
[jump storage="title.ks"]

*switch_to_french
[switch_language lang="fr"]
[jump storage="title.ks"]
[endmacro]
```

### Translation initialization tool

`_filetranslate_TB_init.py` generates all necessary DSV databases when run from the same directory as the game executable.
 
The format is compatible with `filetranslate` [translation tool](https://github.com/UserUnknownFactor/filetranslate).