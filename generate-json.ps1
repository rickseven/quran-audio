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
    $_.Name -notlike ".*" -and $_.Name -ne "node_modules" 
}

Write-Host "Found $($reciterFolders.Count) reciter folder(s):`n" -ForegroundColor Yellow
$reciterFolders | ForEach-Object { Write-Host "  - $($_.Name)" -ForegroundColor Gray }
Write-Host ""

$newItemsCount = 0
$skippedCount = 0

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
        
        # Check if this combination already exists
        if ($existingKeys.ContainsKey($key)) {
            Write-Host "  [SKIP] $surahName (already exists)" -ForegroundColor Gray
            $skippedCount++
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
            }
            
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
$jsonOutput = $finalArray | ConvertTo-Json -Depth 10
$jsonOutput | Out-File -FilePath $jsonFilePath -Encoding UTF8

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "JSON file updated: quran-data.json" -ForegroundColor Green
Write-Host "Total entries: $($finalArray.Count)" -ForegroundColor Yellow
Write-Host "New items added: $newItemsCount" -ForegroundColor Green
Write-Host "Skipped (already exists): $skippedCount" -ForegroundColor Gray
Write-Host "======================================" -ForegroundColor Cyan
