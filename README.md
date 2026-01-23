# Quran Audio Project

A collection of Quran audio recitations organized by reciter.

## Structure

```
quran-audio/
├── mohmed-hesham/       # Reciter folder
│   ├── Al-Baqarah.opus
│   ├── Al-Kahf.opus
│   └── ...
├── quran-data.json      # Generated metadata
└── generate-json.ps1    # Generator script
```

## Usage

### Generate JSON Data

Run the PowerShell script to scan all audio files and generate metadata:

```powershell
.\generate-json.ps1
```

This will:
- Scan all reciter folders
- Extract audio duration using ffprobe
- Generate/update `quran-data.json`
- Skip existing entries (no duplicates)

### Adding New Reciters

1. Create a new folder with the reciter's name (e.g., `abdul-basit`)
2. Add audio files (`.opus`, `.mp3`, `.m4a`, or `.ogg`)
3. Run `.\generate-json.ps1`
4. New entries will be automatically added to `quran-data.json`

## Data Format

```json
{
  "surah": "Al-Baqarah",
  "reciter": "Mohmed Hesham",
  "duration": 8938.43,
  "is_recommend": false
}
```

## Requirements

- PowerShell (Windows)
- ffprobe (for audio duration extraction)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Repository Owner

- **Rick Seven** (@rickseven)
- Email: maseric7@gmail.com

## License

Public Repository - Please respect the content and usage rights.
