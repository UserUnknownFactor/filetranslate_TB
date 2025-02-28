(function() {
const CSV_ESCAPE = '¶';
const CSV_SEPARATOR = '→';
const UTF8_BOM = '\uFEFF';
const CONFIG_NAME = "TranslationConfig.json";

tyrano.plugin.kag.translator = {

tyrano: null,
kag: null,

config: {
    enabled: true,
    debug: true,
    width: 0, // 0 disables word-wrapping
    current_language: "",
    image_folders: ["title", "bgimage", "fgimage"],
    translation_folder: "translated",
    default_language: "jp"
},

data: {
    // For strings, we store an array of translations per scenario:
    // [ [original, translated], [original, translated], ... ]
    strings: [],
    // For tag attributes, we convert the CSV to a dictionary:
    // { original : translated, ... }
    attributes: {},
    characters: {},  // for character translations
    images: {},  // for images
    loaded_files: new Set(),
    translationPointers: {}, // key: scenario, value: next pointer index
    // set to track missing strings so we don't repeatedly scan for them
    missingStrings: {},      // key: scenario, value: Set of missing texts,
    changedOffsets: {}
},

lineBreakStr: "[r]",
lineBreakRegExp: /\[r\]/ig,

init: function () {
    this.tyrano = tyrano;
    this.kag = tyrano.plugin.kag;
    this.loadConfig();
    try {
        if (window.localStorage) {
            const savedLang = localStorage.getItem("game_language");
            if (savedLang && this.config.current_language !== savedLang) {
                this.log(`Found local storage language preference: ${savedLang}`);
                this.config.current_language = savedLang;
            }
        }
    } catch (e) {
        this.error("Could not retrieve saved language preference, using defaults");
    }
    const url_lang = this.getURLParameter("lang");
    if (url_lang) this.config.current_language = url_lang;
    this.patchCoreMethods();
    this.loadCharacterTranslations();
},

filterOwnProps(obj) {
    return Object.assign(Object.create(null), obj)
},

loadConfig: function () {
    const cfgtext = this.getText("data/system/" + CONFIG_NAME);
    if (!cfgtext) {
        this.log("No translator configuration found at data/system, using defaults");
        return;
    }
    const conf = JSON.parse(cfgtext);
    this.config = $.extend(true, this.config, conf);
    if (this.config.debug)
        this.log("Loaded with settings: ", this.filterOwnProps(this.config));
},

getURLParameter: function (name) {
    return decodeURIComponent((new RegExp("[?|&]" + name + "=([^&;]+?)(&|#|;|$)").exec(location.search) || [null, ''])[1]
        .replace(/\+/g, "%20")) || null;
},

patchCoreMethods: function () {
    const that = this;
    const parser = tyrano.plugin.kag.parser;

    // patch parseScenario to translate after original parsing
    let old_parseScenario = parser.old_parseScenario = parser.parseScenario;
    parser.parseScenario = function (text_str) {
        const scenario = old_parseScenario.apply(this, arguments);
        if (!that.config.enabled) return scenario;
        // translate scenario strings after parsing
        that.translateScenario(this.kag.stat.current_scenario, scenario);
        return scenario;
    };

    function getStorageFolder(pm, bg=false) {
            const folder = pm.folder? pm.folder : `${bg ? 'bg' : 'fg'}image`;
            const storage_url = pm.storage && $.isHTTP(pm.storage) ? '' :"data/" + folder;
            return storage_url;
    }

    // patch tag.image.start to translate image paths
    const old_image_start = tyrano.plugin.kag.tag.image.start;
    if (old_image_start)
        tyrano.plugin.kag.tag.image.start = function(pm) {
            if (that.config.enabled && pm.storage) {
                let folder = getStorageFolder(pm);
                pm.storage = that.translateImagePath(pm.storage, folder);
            }
            return old_image_start.call(this, pm);
        };

    const old_button_start = tyrano.plugin.kag.tag.button.start;
    if (old_button_start)
        tyrano.plugin.kag.tag.button.start = function(pm) {
            if (that.config.enabled && (pm.graphic || pm.enterimg)) {
                let folder = getStorageFolder(pm);
                if (pm.graphic)
                    pm.graphic = that.translateImagePath(pm.graphic, folder);
                if (pm.enterimg)
                    pm.enterimg = that.translateImagePath(pm.enterimg, folder);
            }
            return old_button_start.call(this, pm);
        };

    // patch tag.bg.start to translate image paths
    const old_bg_start = tyrano.plugin.kag.tag.bg.start;
    if (old_bg_start)
        tyrano.plugin.kag.tag.bg.start = function(pm) {
            if (that.config.enabled && pm.storage) {
                let folder = getStorageFolder(pm, true);
                pm.storage = that.translateImagePath(pm.storage, folder);
            }
            return old_bg_start.call(this, pm);
        };

    // patch startTag to translate tag parameters on the fly
    /*const old_startTag = tyrano.plugin.kag.ftag.startTag;
    tyrano.plugin.kag.ftag.startTag = function (tag_name, pm) {
        if (!!that.config.enabled)
            pm = that.translateTagParams(tag_name, pm);
        return old_startTag.call(this, tag_name, pm);
    };*/

    // patch chara_ptext.start to translate characters (sidesteps binding)
    const old_chara_ptext_stat = tyrano.plugin.kag.tag.chara_ptext.start;
    tyrano.plugin.kag.tag.chara_ptext.start = function (pm) {
        if (!!that.config.enabled) {
            pm = that.translateTagParams("chara_ptext", pm); 
            if (this.kag.stat.charas[pm.name] && that.data.characters[pm.name])
                this.kag.stat.charas[pm.name].jname = that.data.characters[pm.name];
        }
        return old_chara_ptext_stat.call(this, pm);
    };

    tyrano.plugin.kag.tag.emb = {
        vital: ["exp"],
        // space=Y; adds space on: 3 = both sides, 2 = left, 1 = right
        pm: { exp: '', space: 0b1+0b10 },
        log_join: "true",
        start: function (pm) {
            let val = '' + this.kag.embScript(pm.exp);
            if (pm.space)
                val = `${(pm.space & 0b10 ? ' ' : '')}${val}${(pm.space & 0b1 ? ' ' : '')}`;
            this.kag.ftag.startTag("text", { val: val, backlog: "join", });
        }
    };
},

getLang: function () {
    return this.config.current_language ? '_' + this.config.current_language : '';
},

existsSync: function (file_path) {
    // check if we're in Electron environment
    if (window.require) {
        try {
            // Get the fs module
            const fs = window.require("fs");
            const path = window.require("path");

            // handle relative paths - convert to absolute
            let absolutePath;
            if (!path.isAbsolute(file_path)) {
                const appPath = window.require("electron").remote.app.getAppPath();
                absolutePath = path.join(appPath, file_path);
            } else {
                absolutePath = file_path;
            }

            return fs.existsSync(absolutePath);
        } catch (e) {
            console.log("Error checking file existence:", e);
            return false;
        }
    }

    // fallback to XHR method if not in Electron
    try {
        var xhr = new XMLHttpRequest();
        xhr.open("HEAD", file_path, false);
        xhr.send(null);
        return (xhr.status >= 200 && xhr.status < 400);
    } catch (e) {
        return false;
    }
},

getText: function (file_path) {
    // check if we're in Electron environment
    if (window.require) {
        try {
            // get the fs module
            const fs = window.require("fs");
            const path = window.require("path");

            // handle relative paths - convert to absolute
            let absolutePath;
            if (!path.isAbsolute(file_path)) {
                const appPath = window.require("electron").remote.app.getAppPath();
                absolutePath = path.join(appPath, file_path);
            } else {
                absolutePath = file_path;
            }

            // handle asar archives
            if (absolutePath.includes(".asar")) {
                const asarPath = absolutePath.split(".asar")[0] + ".asar";
                const relativePath = absolutePath.split(".asar")[1];

                if (fs.existsSync(asarPath)) {
                    const originalFs = window.require("original-fs");
                    if (originalFs.existsSync(asarPath + relativePath)) {
                        return originalFs.readFileSync(asarPath + relativePath, "utf8");
                    }
                }
            }

            // regular file read
            if (fs.existsSync(absolutePath))
                return fs.readFileSync(absolutePath, "utf8");
            return "";
        } catch (e) {
            console.log("Error reading file:", e);
            return "";
        }
    }

    // fallback to XHR method if not in Electron
    let result = "";
    try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", file_path + "?" + Math.floor(Math.random() * 1000000), false);
        xhr.overrideMimeType("text/plain; charset=UTF-8");
        xhr.onerror = function () { /* silent */ };
        xhr.send();
        if (xhr.status === 200) result = xhr.responseText || result;
    } catch (e) {
        result = "";
    }
    return result;
},


getTranslationPath: function (path, image) {
    const lang = this.getLang();
    if (image)
        return path.indexOf('/') !== -1 ? path.replace(/(.*\/)([^\/]+)$/, `$1${this.config.translation_folder}${lang}/$2`) : `translated${lang}/${path}`;
    const base = path.split('.')[0];
    return `./data/${this.config.translation_folder}/${base}${lang}.csv`;
},

csvToArray: function (text, toDict) {
    // If toDict is true, we assume CSV rows of the form:
    // [original, translated, optional_context...]
    // and we only use the first two columns.
    if (!text) return [];
    const ch_newline = '\n';
    let pletter = '',
        row = [''],
        ret = [row],
        i = 0,
        r = 0,
        unescaped = true;
    for (let letter of text) {
        if (UTF8_BOM === letter) {
            continue;
        } else if (CSV_ESCAPE === letter) {
            if (!unescaped && pletter === CSV_ESCAPE) row[i] += letter;
            unescaped = !unescaped;
        } else if (CSV_SEPARATOR === letter && unescaped) {
            letter = row[++i] = '';
        } else if (ch_newline === letter && unescaped) {
            if ('\r' === pletter) row[i] = row[i].slice(0, -1);
            row = ret[++r] = [''];
            i = 0;
        } else {
            row[i] += letter;
            if (!unescaped) unescaped = true;
        }
        pletter = letter;
    }
    // filter out unused rows (e.g. comments and empty rows)
    ret = ret.filter(list => typeof list[0] === "string" && list.length > 1 &&
        !(list[0].startsWith("//") && !list[1].startsWith("//")));
    if (toDict) {
        // convert array rows (only first two columns) into an object
        return Object.assign({}, ...ret.map(x => ({ [x[0]]: x[1] })));
    }
    return ret;
},

translateImagePath: function (path, directory) {
    if (!path) return path;
    if (this.data.images[path]) return this.data.images[path];
    if (!directory) directory = '';

    const folder = path.split('/')[0];
    let folder_base =  directory.split('/');
    folder_base =  (folder_base && folder_base[0] === 'data' && folder_base.length > 1) ? folder_base[1] : 'data';
    if (this.config.image_folders.indexOf(folder) === -1 && this.config.image_folders.indexOf(folder_base) === -1) return path;

    const translated_path = this.getTranslationPath(path, true);

    const full_path = directory ? directory + '/' + translated_path : translated_path;
    if (this.existsSync(full_path)) {
        this.data.images[path] = translated_path;
        this.log(`Replaced image ${path} with translated image ${translated_path}`);
        return translated_path;
    }

    return path;
},

tryLoadTranslations: function (scenario) {
    if (!this.data.strings[scenario]) this.data.strings[scenario] = [];
    if (!this.data.attributes[scenario]) this.data.attributes[scenario] = {};

    const lang = this.getLang();
    const translationPathStrings = "data/scenario/" + scenario.replace(".ks", `_strings${lang}.csv`);
    const translationPathAttributes = "data/scenario/" + scenario.replace(".ks", `_attributes${lang}.csv`);

    if (scenario.indexOf("scene1") !== -1)
        scenario = scenario;

    // synchronously check and load string translations, if the file exists
    if (this.existsSync(translationPathStrings) &&
        !this.data.loaded_files.has(translationPathStrings)) {
        const dataString = this.getText(translationPathStrings);
        if (!dataString) {
            this.error(`Error loading string translations for ${scenario}`);
            return;
        }
        this.data.strings[scenario] = this.csvToArray(dataString);
        this.data.loaded_files.add(translationPathStrings);
        this.log(`Loaded ${this.data.strings[scenario].length} string translations for ${scenario}`);

    }

    // synchronously check and load attribute translations, if the file exists
    if (this.existsSync(translationPathAttributes) &&
        !this.data.loaded_files.has(translationPathAttributes)) {
        const dataAttr = this.getText(translationPathAttributes);
        if (!dataAttr) {
            this.error(`Error loading attribute translations for ${scenario}`);
            return;
        }
        this.data.attributes[scenario] = this.csvToArray(dataAttr, true);
        this.data.loaded_files.add(translationPathAttributes);
        this.log(`Loaded ${Object.keys(this.data.attributes[scenario]).length} attribute translations for ${scenario}`);
    }
},

tagREGE: /\[([a-z0-9_\-]+)(\s+[^\]]*?)?\]/gi,
findTranslationMatch: function(originalTextNormalized, translations, pointer) {
    const maxDistance = 15;

    // check current pointer first
    if (pointer < translations.length) {
        const expectedOriginalNormalized = this.normalizeString(translations[pointer][0]);
        if (originalTextNormalized === expectedOriginalNormalized)
            return { found: true, index: pointer };
    }

    // forward search
    for (let forward = 1; forward <= maxDistance && pointer + forward < translations.length; forward++) {
        const expectedOriginalNormalized = this.normalizeString(translations[pointer + forward][0]);
        if (originalTextNormalized === expectedOriginalNormalized)
            return { found: true, index: pointer + forward };
    }

    // partial search (like strings broken by ruby tags)
    for (let idx = 0; idx < translations.length; idx++) {
        const originalFullText = translations[idx][0];
        if (originalFullText.indexOf('[') === -1) continue;

        const parsedOriginal = tyrano.plugin.kag.parser.old_parseScenario(originalFullText).array_s;
        for (let j = 0; j < parsedOriginal.length; j++) {
            if (parsedOriginal[j].name === "text") {
                const textSegment = this.normalizeString(parsedOriginal[j].pm.val);
                if (textSegment === originalTextNormalized)
                    return { found: true, index: idx };
            }
        }
    }

    // backward search
    for (let backward = 1; backward <= maxDistance && pointer - backward >= 0; backward++) {
        const expectedOriginalNormalized = this.normalizeString(translations[pointer - backward][0]);
        if (originalTextNormalized === expectedOriginalNormalized)
            return { found: true, index: pointer - backward };
    }

    // full file search (excluding already searched range)
    for (let idx = 0; idx < translations.length; idx++) {
        if (idx >= pointer - maxDistance && idx <= pointer + maxDistance) continue;

        const expectedOriginalNormalized = this.normalizeString(translations[idx][0]);
        if (originalTextNormalized === expectedOriginalNormalized)
            return { found: true, index: idx };
    }

    return { found: false, index: -1 };
},

generateOriginalStringsSet: function(translations) {
    const originalStringsSet = new Set();
    for (let i = 0; i < translations.length; i++) {
        const translationPair = translations[i];
        // store both the normalized string and the raw string to handle cases with tags
        const normalizedString = this.normalizeString(translationPair[0]);
        originalStringsSet.add(normalizedString);

        // also parse and store each text segment from the original string with tags
        if (translationPair[0].match(/\[/)) {
            const parsed = tyrano.plugin.kag.parser.old_parseScenario(translationPair[0]).array_s;
            for (let j = 0; j < parsed.length; j++) {
                if (parsed[j].name === "text") {
                    const textSegment = this.normalizeString(parsed[j].pm.val);
                    if (textSegment)
                        originalStringsSet.add(textSegment);
                }
            }
        }
    }
    return originalStringsSet;
},

translateScenario: function (scenario, scenario_obj) {
    const array_s = scenario_obj.array_s;
    if (!scenario) return;

    this.tryLoadTranslations(scenario);

    const translations = this.data.strings[scenario];
    const attributes = this.data.attributes[scenario];
    if (!translations.length && !Object.keys(attributes).length) return;

    if (!this.data.translationPointers[scenario]) this.data.translationPointers[scenario] = 0;
    if (!this.data.missingStrings[scenario]) this.data.missingStrings[scenario] = new Set();

    const originalStringsSet = this.generateOriginalStringsSet(translations);
    let is_script = false;
    let pointer = this.data.translationPointers[scenario];
    const missingSet = this.data.missingStrings[scenario];
    const maxDistance = 15;

    // track offset changes
    const offsetChanges = [];

    // process text nodes
    for (let i = 0; i < array_s.length; i++) {
        const tobj = array_s[i];
        if (tobj.name === "iscript")
            is_script = true;
        else if (tobj.name === "endscript")
            is_script = false;
        else if (tobj.name === "label") {
            const label_key = tobj.pm.label_name;
            // fix the label drift due to inserts
            tobj.pm.index = i;
            if (scenario_obj.map_label[label_key]) {
                scenario_obj.map_label[label_key].index = i;
            } else {
                this.error(`Unknown label found: ${label_key}`);
                //scenario_obj.map_label[label_key] =  { line: 0, index: i, label_name: label_key, val: tobj.pm.val };
            }
        } else if (tobj.name === "text") {
            if (!is_script) {
                if (translations.length > 0) {
                    const originalTextNormalized = this.normalizeString(tobj.pm.val);
                    if (!originalTextNormalized) continue;

                    // Quick check if we have any translation for this text
                    if (!originalStringsSet.has(originalTextNormalized)) {
                        if (!missingSet.has(originalTextNormalized)) missingSet.add(originalTextNormalized);
                        continue;
                    }

                    const searchResult = this.findTranslationMatch(originalTextNormalized, translations, pointer, maxDistance);
                    if (searchResult.found) {
                        const [newIndex, countDiff] = this.applyTranslationWithParser(array_s, i, translations[searchResult.index]);
                        if (countDiff !== 0)
                            offsetChanges.push({ index: i, difference: countDiff });
                        i = newIndex;
                        pointer = searchResult.index + 1;
                        this.data.translationPointers[scenario] = pointer;
                    } else {
                        if (!missingSet.has(originalTextNormalized)) missingSet.add(originalTextNormalized);
                    }
                } else {
                    const textNormalized = this.normalizeString(tobj.pm.val);
                    if (textNormalized && !missingSet.has(textNormalized)) {
                        missingSet.add(textNormalized);
                        this.log(`No translation available for text: "${textNormalized}" in scenario ${scenario}`);
                    }
                }
            }
        } else if (tobj.name === "chara_ptext") {
            if (tobj.pm && tobj.pm.name) {
                const chara_name = tobj.pm.name;
                if (this.data.characters[chara_name]) {
                    if (this.kag.stat.charas[chara_name])
                        this.kag.stat.charas[chara_name].jname = this.data.characters[chara_name] || chara_name;
                    else
                        tobj.pm.name = this.data.characters[chara_name];
                }
            }
        } else if (tobj.name === "eval") {
            if (tobj.pm && tobj.pm.exp) {
                const script = tobj.pm.exp;
                if (attributes[script]) {
                    this.log(`${tobj.pm.exp} -> ${attributes[script]} @${i}`);
                    tobj.pm.exp = attributes[script];
                }
            }
        } else if (tobj.pm) {
            for (let key in tobj.pm)
                if (attributes[tobj.pm[key]])
                    tobj.pm[key] = attributes[tobj.pm[key]];
        }
    }
},

applyTranslationWithParser: function (array_s, index, translationPair) {
    const originalText = translationPair[0];
    let translatedText = translationPair[1].replace(/^\s*\*/, "\\*");

    const parsed_array_old = tyrano.plugin.kag.parser.old_parseScenario(originalText).array_s || [];
    const parsed_array_new = tyrano.plugin.kag.parser.old_parseScenario(translatedText).array_s || [];

    // try to minimize costly splices, compare element sequences
    let sameSequence = parsed_array_old.length === parsed_array_new.length;

    // process word wrapping for new text elements
    for (let i = 0; i < parsed_array_new.length; i++) {
        if (sameSequence && parsed_array_old[i].name !== parsed_array_new[i].name) 
            sameSequence = false;

        if (parsed_array_new[i].name === "text") {
            const wrappedText = this.applyWordWrapping(parsed_array_new[i].pm.val);
            const reparsed = tyrano.plugin.kag.parser.old_parseScenario(wrappedText).array_s || [];
            if (reparsed.length > 1) 
                sameSequence = false;

            reparsed.forEach(element => {
                if (element.name === "text") {
                    element.pm.val = element.pm.val.replace(/^\\\*/, '*');
                    element.val = element.val.replace(/^\\\*/, '*');
                }
            });
            // replace the current element with the reparsed elements
            parsed_array_new.splice(i, 1, ...reparsed);

            // adjust the index to account for the newly inserted elements
            i += reparsed.length - 1;
        }
    }

    // adjust index to point to actual text start of the translated content
    let oldTextStart = parsed_array_old.findIndex(obj => obj.name === "text");
    oldTextStart = oldTextStart === -1 ? 0 : oldTextStart;
    const actualIndex = index - oldTextStart;

    if (sameSequence) {
        // just update text content where needed
        parsed_array_new.forEach((newObj, i) => {
            if (newObj.name === "text") {
                array_s[actualIndex + i].pm.val = newObj.pm.val;
                array_s[actualIndex + i].val = newObj.val;
            }
        });
        return [actualIndex + parsed_array_new.length - 1, 0];
    }

    // different sequence - need to splice
    const elementsToRemove = parsed_array_old.length || 1;
    const countDifference = parsed_array_new.length - elementsToRemove;
    array_s.splice(actualIndex, elementsToRemove, ...parsed_array_new);

    return [actualIndex + parsed_array_new.length - 1, countDifference];
},

sharedContext:document.createElement("canvas").getContext("2d"),

// word wrapper function that respects pixel width
wordWrap: function (text, maxWidth, fontFamily, fontSize, additionalSpacing) {
    if (!text) return '';

    //this.log("Original line:", text);
    const context = this.sharedContext;

    // function to measure text width
    const measureText = (text) => {
        return context.measureText(text).width + additionalSpacing;
    };

    // NOTE: We ignore fontFamily here since loading game may create 
    // a context without the font loaded, giving different results.
    // It's not precise but creates a good estimate.
    fontFamily = "sans-serif";
    context.font = `${fontSize}px ${fontFamily}`;

    const paragraphs = text.split(/\n/);
    const wrappedLines = [];

    for (let i = 0; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i];

        // skip empty paragraphs but preserve the line break
        if (!paragraph.trim()) {
            wrappedLines.push('');
            continue;
        }

        // Split the paragraph into words
        // In Japanese/Chinese, we treat each character as a "word".
        // For other languages, split by spaces.
        const isJapaneseOrChinese = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/.test(paragraph);
        const words = isJapaneseOrChinese
            ? paragraph.split('')
            : paragraph.split(/\s+/);

        let currentLine = '';
        let currentWidth = 0;

        for (let j = 0; j < words.length; j++) {
            const word = words[j];
            const wordWidth = measureText(isJapaneseOrChinese ? word : ` ${word}`);

            // check if adding this word would exceed the max width
            if (currentWidth + wordWidth > maxWidth && currentLine !== '') {
                // push the current line and start a new one
                //this.log("Wrapped line:", context.font, currentWidth, word + ':', wordWidth, maxWidth, currentLine);
                wrappedLines.push(currentLine);
                currentLine = word;
                currentWidth = measureText(word);
            } else {
                // add the word to the current line
                if (currentLine === '') {
                    currentLine = word;
                    currentWidth = measureText(word);
                } else {
                    currentLine += (isJapaneseOrChinese ? '' : ' ') + word;
                    currentWidth += wordWidth;
                }
            }
        }

        // push the last line if it's not empty
        if (currentLine !== '')
            wrappedLines.push(currentLine);
    }

    // join all lines with line breaks while removing any of the old ones
    if (wrappedLines.length > 1) {
        wrappedLines.forEach((elem, i) => {
            if (i < wrappedLines.length - 1)
                wrappedLines[i] = wrappedLines[i].replace(this.lineBreakRegExp, '');
        });
        return wrappedLines.join(this.lineBreakStr);
    }
    return text;
},

// inside text processing
applyWordWrapping: function (text) {
    if (!this.config.width)
        return text;

    const fontFamily = tyrano.plugin.kag.config.userFace || "sans-serif";
    const fontSize = parseInt(tyrano.plugin.kag.config.defaultFontSize) || 24;
    const additionalSpacing = 2;

    return this.wordWrap(text, this.config.width, fontFamily, fontSize, additionalSpacing);
},

normalizeString: function (str) {
    if (!str) return '';
    let normalized = str.replace(/\u200B/g, '').trim();
    return normalized.replace(this.tagREGE, '');
},

translateTagParams: function (tag_name, params) {
    if (!params) return params;

    const scenario = tyrano.plugin.kag.stat.current_scenario;
    this.tryLoadTranslations(scenario);

    const translations = this.data.strings[scenario];
    const attributes = this.data.attributes[scenario];
    if (!translations.length && !Object.keys(attributes).length) return params;

    if (tag_name === "text" || tag_name === "label" || tag_name === "button") 
        if (params.text && attributes[params.text]) params.text = attributes[params.text];

    // Handle character name translations
    if (tag_name === "chara_ptext" || tag_name === "chara_config")
        if (params.name && this.data.characters[params.name])
            params.name = this.data.characters[params.name];

    // Process every parameter for attribute translations
    for (let key in params) {
        if (attributes[key])
            params[key] = attributes[key];
    }

    return params;
},

loadCharacterTranslations: function () {
    const that = this;
    const charTranslationPath = `./data/scenario/characters${this.getLang()}.csv`;
    if (this.existsSync(charTranslationPath) &&
        !this.data.loaded_files.has(charTranslationPath)) {
        const dataAttr = this.getText(charTranslationPath);
        if (!dataAttr) {
            this.error(`Error loading character translations for ${scenario}`);
            return;
        }
        this.data.characters = this.csvToArray(dataAttr, true);
        this.data.loaded_files.add(charTranslationPath);
        this.log(`Loaded ${Object.keys(this.data.characters).length} character translations`);
    } else {
        this.log(`No character translations file found at ${charTranslationPath}`);
        return;
    }
},

// method to switch language at runtime
switchLanguage: function (language) {
    this.config.current_language = language;
    // Reset all per-scenario caches
    this.data.loaded_files.clear();
    this.data.strings = {};
    this.data.attributes = {};
    this.data.characters = {};
    this.data.images = {};
    this.data.translationPointers = {};
    this.data.missingStrings = {};
    tyrano.plugin.kag.cache_scenario = {}; // clean scenario cache

    // load character translations
    this.loadCharacterTranslations();

    // refresh the screen
    tyrano.plugin.kag.ftag.startTag("clearfix", {});
    tyrano.plugin.kag.ftag.startTag("awakegame", {});
},

// utility method for logging normal flow
log: function (message) {
    if (this.config.debug) console.log.apply(this, ["[_filetranslateTB]", ...arguments]);
},

// utility method for logging error flow
error: function (message) {
    if (this.config.debug) console.warn.apply(this, ["[_filetranslateTB]", ...arguments]);
},

// utility method for labels checking
printLabels: function (scenarioPath, scenario, CONTEXT_SIZE = 2) {
    // get the scenario data
    scenario = scenario || tyrano.plugin.kag.cache_scenario[scenarioPath];
    scenarioPath = 'unspecified' || scenarioPath;
    if (!scenario || !scenario.map_label || !scenario.array_s) {
        this.error(`Scenario data not found for ${scenarioPath}`);
        return;
    }
    
    const labels = scenario.map_label;
    const arrayS = scenario.array_s;
    
    console.log(`=== Labels for ${scenarioPath} ===`);
    
    // iterate through each label
    for (const labelName in labels) {
        const labelInfo = labels[labelName];
        if (!labelInfo || typeof labelInfo.index !== 'number') continue;
        
        const index = labelInfo.index,
                arrayItem = arrayS[index];
        
        console.log(`\n--- Label: ${labelName} (index: ${index}) ---`);
        console.log(arrayItem);
        
        // print a few surrounding items for context (optional)
        console.log("\nContext:");
        for (let i = Math.max(0, index - CONTEXT_SIZE); i <= Math.min(arrayS.length - 1, index + CONTEXT_SIZE); i++)
            console.log(`${(i === index) ? '→' : ''} [${i}]: ${JSON.stringify(arrayS[i])}`);
    }
}

}; // end tyrano.plugin.kag.translator

tyrano.plugin.kag.tag.switch_language = {
vital: ["lang"],
pm: {
    lang: ""
},
start: function (pm) {
    const that = this;
    const translator = tyrano.plugin.kag.translator;
    let saved = false;
    let last_error = '';

    translator.log(`Switching language to: ${pm.lang}`);
    translator.switchLanguage(pm.lang);

    // save the language preference if storage is available
    try {
        if (window.localStorage) {
            localStorage.setItem("game_language", !!pm.lang ? '_' + pm.lang : '');
            translator.log("Language preference saved to localStorage");
            saved = true;
        } else {
            last_error = "no local storage";
        }
    } catch (e) {
        last_error = e.toString();
    }
    if (!saved) translator.log("Could not save language preference: \n" + last_error);

    that.kag.ftag.nextOrder();
}
}; // end tyrano.plugin.kag.tag.switch_language

tyrano.plugin.kag.translator.init();

})();