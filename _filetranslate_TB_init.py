import argparse
import re
import os
import glob

# Constants matching the plugin
CSV_SEPARATOR = '→'
CSV_ESCAPE = '¶'
UTF8_BOM = '\uFEFF'

def escape_csv(text):
    if not text:
        return ""
    # Escape the escape character first
    text = text.replace(CSV_ESCAPE, CSV_ESCAPE + CSV_ESCAPE)
    # Escape the separator
    text = text.replace(CSV_SEPARATOR, CSV_ESCAPE + CSV_SEPARATOR)
    # Escape newlines
    text = text.replace('\n', CSV_ESCAPE + '\n')
    return text

def write_csv(filepath, rows):
    with open(filepath, 'wb') as f:
        f.write(UTF8_BOM.encode('utf-8'))  # Add BOM
        for row in rows:
            escaped_row = [escape_csv(cell) for cell in row]
            f.write((CSV_SEPARATOR.join(escaped_row) + '\n').encode('utf-8'))

def read_csv(filepath):
    result = {}
    try:
        with open(filepath, 'r', encoding="utf-8") as f:
            content = f.read()
            if content.startswith(UTF8_BOM):
                content = content[len(UTF8_BOM):]

        for line in content.split('\n'):
            if not line.strip():
                continue
            parts = []
            unescaped = True
            current = ""

            for char in line:
                if char == CSV_ESCAPE:
                    if not unescaped and char == CSV_ESCAPE:
                        current += char
                    unescaped = not unescaped
                elif char == CSV_SEPARATOR and unescaped:
                    parts.append(current)
                    current = ""
                else:
                    current += char
                    if not unescaped:
                        unescaped = True

            if current:
                parts.append(current)

            if len(parts) >= 2:
                result[parts[0]] = parts[1]
    except Exception as e:
        print(f"Error reading CSV file {filepath}: {e}")
    
    return result

def extract_text_from_ks(ks_file):
    with open(ks_file, 'r', encoding="utf-8") as f:
        content = f.readlines()

    strings = []
    attributes = {}
    characters = {}

    in_script = False
    for line in content:
        line = line.strip()
        if not line:
            continue

        if line.startswith("[iscript]"):
            in_script = True
            continue
        elif line.startswith("[endscript]"):
            in_script = False
            continue

        if in_script:
            continue

        # Handle tagged text
        non_translatable_prefixes = ['[', ';', '@', '*', '#', '//', '/*']#, '】', '【']
        if line.startswith("[text"):
            # Extract text from [text] tag if present
            text_match = re.search(r"\[text[^\]]*\](.*?)(\[endtext\])?$", line)
            if text_match and text_match.group(1).strip():
                strings.append([text_match.group(1).strip(), ""])
        # Handle plain text lines (no tags at beginning of line) or some silliness like text starting with [r]
        elif not any(line.strip().startswith(prefix) for prefix in non_translatable_prefixes) or (re.match(r'^\s*\[(?:l|r|ruby|emb)\b', line) and len(line) > 3):
            strings.append([line, ""])

        chara_match = re.search(r'\[chara_ptext\s+.*?name\s*=\s*"([^"]+)".*?\]|^#([^\n]+)', line)
        if chara_match:
            chara_name = chara_match.group(1) or chara_match.group(2)
            if chara_name not in characters:
                characters[re.sub(r' ', '', chara_name)] = ""

        # Extract eval expressions (comment them initially)
        eval_match = re.search(r'(?:\[eval|@eval)\s+exp\s*=\s*([\"\'])([^\1]+)\1.*?\]', line)
        if eval_match:
            exp = eval_match.group(2)
            if exp:
                exp = "//" + exp
                exp = re.sub(r"\s*([\+\-]*)=\s*", r'\1=', exp)
                if exp and exp.strip() and exp not in attributes:
                    attributes[re.sub(r' ', '', exp)] = ""

        # Extract other attributes with name=value pattern in tags
        attribute_matches = re.finditer(r'\[[^\]]+?(?:\s+(?:j?name|text|title|alt|label)\s*=\s*\"([^\"\n]+)\")(?:\s+(?:j?name|text|title|alt|label)\s*=\s*\"([^\"\n]+)\")?(?:\s+(?:j?name|text|title|alt|label)\s*=\s*\"([^\"\n]+)\")?', line)
        for match in attribute_matches:
            attr_value = match.group(1) or match.group(2) or match.group(3)
            attr_value = "//" + attr_value.strip()
            if attr_value not in attributes:
                attributes[re.sub(r' ', '', attr_value)] = ""

    return strings, attributes, characters

def merge_translations(original_data, existing_translations):
    if isinstance(original_data, list):
        # For list items (strings)
        for i, item in enumerate(original_data):
            if item[0] in existing_translations:
                original_data[i][1] = existing_translations[item[0]]
    else:
        # For dictionary items (attributes, characters)
        for key in original_data:
            if key in existing_translations:
                original_data[key] = existing_translations[key]
    
    return original_data

def main():
    parser = argparse.ArgumentParser(description="Extract translatable content from TyranoBuilder .ks files")
    parser.add_argument("input", default='.', nargs='?', help="Input .ks file or directory containing .ks files")
    parser.add_argument("-o", "--output", help="Output directory for translation files", default='')
    parser.add_argument("-l", "--lang", help="Target language code", default='')
    parser.add_argument("-f", "--force", action="store_true", help="Overwrite existing translation files")
    parser.add_argument("-d", "--data-dir", help="Path to data directory for placing translations", default="data/scenario")
    parser.add_argument("-m", "--merge", action="store_true", help="Merge with existing translation files if they exist")

    args = parser.parse_args()

    if args.output:
        os.makedirs(args.output, exist_ok=True)

    args.verbose = True
    args.lang = '_' + args.lang if args.lang else ''

    if os.path.isfile(args.input) and args.input.endswith(".ks"):
        ks_files = [args.input]
    elif os.path.isdir(args.input):
        ks_files = glob.glob(os.path.join(args.input, "**", "*.ks"), recursive=True)
    else:
        parser.error("Input must be a .ks file or a directory containing .ks files")

    if args.verbose:
        print(f"Found {len(ks_files)} .ks files to process")

    all_characters = {}
    for ks_file in ks_files:
        if args.verbose:
            print(f"Processing {ks_file}")

        base_name = os.path.splitext(os.path.basename(ks_file))[0]
        base_dir = os.path.dirname(ks_file)

        strings, attributes, characters = extract_text_from_ks(ks_file)
        all_characters.update(characters)

        # Process strings file
        if strings:
            strings_file = os.path.join(args.output if args.output else base_dir, f"{base_name}_strings{args.lang}.csv")
            if os.path.exists(strings_file) and args.merge:
                existing_strings = read_csv(strings_file)
                strings = merge_translations(strings, existing_strings)
                if args.verbose:
                    print(f"Merged with existing strings file: {strings_file}")

            if not os.path.exists(strings_file) or args.force or args.merge:
                write_csv(strings_file, strings)
                if args.verbose:
                    print(f"Created strings file: {strings_file} with {len(strings)} entries")
            else:
                if args.verbose:
                    print(f"Skipping existing file: {strings_file}")

        # Process attributes file
        if attributes:
            # Convert attributes dict to list of [key, value] pairs
            attr_rows = [[key, value] for key, value in attributes.items()]
            attr_file = os.path.join(args.output if args.output else base_dir, f"{base_name}_attributes{args.lang}.csv")

            if os.path.exists(attr_file) and args.merge:
                existing_attrs = read_csv(attr_file)
                attributes = merge_translations(attributes, existing_attrs)
                attr_rows = [[key, value] for key, value in attributes.items()]
                if args.verbose:
                    print(f"Merged with existing attributes file: {attr_file}")

            if not os.path.exists(attr_file) or args.force or args.merge:
                write_csv(attr_file, attr_rows)
                if args.verbose:
                    print(f"Created attributes file: {attr_file} with {len(attr_rows)} entries")
            else:
                if args.verbose:
                    print(f"Skipping existing file: {attr_file}")

    # Process the global characters file
    if all_characters:
        char_rows = [[key, value] for key, value in all_characters.items()]
        char_file = os.path.join(args.output if args.output else os.path.dirname(ks_files[0]), f"characters{args.lang}.csv")

        if os.path.exists(char_file) and args.merge:
            existing_chars = read_csv(char_file)
            all_characters = merge_translations(all_characters, existing_chars)
            char_rows = [[key, value] for key, value in all_characters.items()]
            if args.verbose:
                print(f"Merged with existing characters file: {char_file}")

        if not os.path.exists(char_file) or args.force or args.merge:
            write_csv(char_file, char_rows)
            if args.verbose:
                print(f"Created characters file: {char_file} with {len(char_rows)} entries")
        else:
            if args.verbose:
                print(f"Skipping existing file: {char_file}")

    # Create a readme file with instructions
    readme_file = os.path.join(args.output, "README.md")
    if not os.path.exists(readme_file):
        with open(readme_file, 'w', encoding="utf-8") as f:
            f.write(f"""# Translation Files for TyranoBuilder Game

These files are generated for translation of a TyranoBuilder game.

## File Format

- Files use a custom CSV format with `{CSV_SEPARATOR}` as separator and `{CSV_ESCAPE}` as escape character
- Each row has the original text in the first column and the translated text in the second column
- Fill in the second column with your translations

## How to Use

1. Translate the content in each file
2. Place the translated files in the `{args.data_dir}` directory of your game
3. Make sure the translator plugin is properly configured

## File Types

- `*_strings{args.lang}.csv`: Contains dialogue and descriptive text
- `*_attributes{args.lang}.csv`: Contains character names and other attributes
- `characters{args.lang}.csv`: Contains all character names used in the game""")

    if args.verbose:
        print("Translation extraction complete!")

if __name__ == "__main__":
    main()