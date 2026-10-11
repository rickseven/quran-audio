$baseFolder = "c:\Users\Eric\Projects\quran-audio"
$jsonFilePath = "$baseFolder\quran-data.json"

# Load existing data if file exists
$existingData = @()
if (Test-Path $jsonFilePath) {
    Write-Host "Loading existing quran-data.json..." -ForegroundColor Cyan
    $jsonContent = Get-Content $jsonFilePath -Raw -Encoding UTF8
    $existingData = $jsonContent | ConvertFrom-Json
    Write-Host "Found $($existingData.Count) existing entries`n" -ForegroundColor Green
}

# Convert existing data to hashtable for quick lookup
$existingKeys = @{}
foreach ($item in $existingData) {
    $key = "$($item.surah)|$($item.reciter)"
    $existingKeys[$key] = $item
}

# Get all folders in base directory (each folder = reciter)
$reciterFolders = Get-ChildItem -Path $baseFolder -Directory | Where-Object { 
    $_.Name -notlike ".*" -and $_.Name -notin @("node_modules", "lyrics", "tools", "unknown") 
}

Write-Host "Found $($reciterFolders.Count) reciter folder(s):`n" -ForegroundColor Yellow
$reciterFolders | ForEach-Object { Write-Host "  - $($_.Name)" -ForegroundColor Gray }
Write-Host ""

$lyricsFolder = "$baseFolder\lyrics"
$lyricsTool = Join-Path $baseFolder "tools/srt-to-lyrics.js"
$newItemsCount = 0
$skippedCount = 0
$lyricsCount = 0

# Generate lyrics/<surah>.json from lyrics/<surah>.srt (with id/en translations from quran.com)
# Returns the web path of the lyrics file, or $null when there is no .srt / generation failed.
function Update-Lyrics($surahName, $audioPath, [switch]$Force) {
    $srt = Join-Path $lyricsFolder "$surahName.srt"
    $json = Join-Path $lyricsFolder "$surahName.json"
    if (-not (Test-Path $srt)) { return $null }

    $stale = (-not (Test-Path $json)) -or ((Get-Item $srt).LastWriteTime -gt (Get-Item $json).LastWriteTime)
    if ($stale -or $Force) {
        Write-Host "  [LYRICS] $surahName.srt -> $surahName.json" -ForegroundColor Magenta
        & node $lyricsTool $srt --chapter $surahName --title $surahName --audio $audioPath --out $json
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [ERROR] Lyrics generation failed for: $surahName" -ForegroundColor Red
            return $null
        }
        $script:lyricsCount++
    }
    return "/lyrics/$surahName.json"
}

foreach ($reciterFolder in $reciterFolders) {
    $folderName = $reciterFolder.Name
    # Convert folder name to readable reciter name (e.g., "mohmed-hesham" -> "Mohmed Hesham")
    $reciterName = ($folderName -split '-' | ForEach-Object { 
        $_.Substring(0,1).ToUpper() + $_.Substring(1) 
    }) -join ' '
    
    Write-Host "Processing reciter: $reciterName ($folderName)..." -ForegroundColor Cyan
    
    # Get all audio files in this reciter folder
    $audioFiles = Get-ChildItem -Path $reciterFolder.FullName -Filter "*.opus" -ErrorAction SilentlyContinue
    
    if (-not $audioFiles) {
        # Try other audio formats
        $audioFiles = Get-ChildItem -Path $reciterFolder.FullName -Include "*.mp3","*.m4a","*.ogg" -ErrorAction SilentlyContinue
    }
    
    if (-not $audioFiles) {
        Write-Host "  No audio files found, skipping...`n" -ForegroundColor Yellow
        continue
    }
    
    foreach ($file in $audioFiles) {
        $surahName = $file.BaseName
        $key = "$surahName|$reciterName"
        
        $audioPath = "/$folderName/$($file.Name)"

        # Check if this combination already exists
        if ($existingKeys.ContainsKey($key)) {
            Write-Host "  [SKIP] $surahName (already exists)" -ForegroundColor Gray
            $skippedCount++
            # Still refresh lyrics when a .srt is present
            $lyrics = Update-Lyrics $surahName $audioPath
            if ($lyrics) {
                $existingKeys[$key] | Add-Member -NotePropertyName lyrics -NotePropertyValue $lyrics -Force
            }
            continue
        }
        
        # Get duration using ffprobe
        try {
            $ffprobeOutput = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $file.FullName 2>&1
            
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  [ERROR] Could not get duration for: $surahName" -ForegroundColor Red
                continue
            }
            
            $duration = [math]::Round([double]$ffprobeOutput, 2)
            
            $jsonObject = [PSCustomObject]@{
                surah = $surahName
                reciter = $reciterName
                duration = $duration
                is_recommend = $false
                file = $audioPath
                lyrics = ""
            }

            $lyrics = Update-Lyrics $surahName $audioPath
            if ($lyrics) { $jsonObject.lyrics = $lyrics }
            
            $existingKeys[$key] = $jsonObject
            $newItemsCount++
            
            Write-Host "  [NEW] $surahName - Duration: $duration seconds" -ForegroundColor Green
        }
        catch {
            Write-Host "  [ERROR] Failed to process: $surahName - $_" -ForegroundColor Red
        }
    }
    
    Write-Host ""
}

# Convert hashtable back to sorted array
$finalArray = $existingKeys.Values | Sort-Object reciter, surah

# Save to JSON
# Re-format with node (2-space indent, UTF-8 without BOM) so diffs stay minimal
$jsonOutput = $finalArray | ConvertTo-Json -Depth 10
$pretty = $jsonOutput | & node (Join-Path $baseFolder "tools/format-json.js")
[System.IO.File]::WriteAllText($jsonFilePath, (($pretty -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "JSON file updated: quran-data.json" -ForegroundColor Green
Write-Host "Total entries: $($finalArray.Count)" -ForegroundColor Yellow
Write-Host "New items added: $newItemsCount" -ForegroundColor Green
Write-Host "Skipped (already exists): $skippedCount" -ForegroundColor Gray
Write-Host "Lyrics generated: $lyricsCount" -ForegroundColor Magenta
Write-Host "======================================" -ForegroundColor Cyan
