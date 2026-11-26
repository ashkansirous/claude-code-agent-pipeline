# Parses each script in -Paths without running it; prints "parse ok <file>" or "<file>:<line>:<column> <message>".
# Called only by ps-parse.mjs, through -File (never -Command: -Command appends trailing args to its text and runs them).
# Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file as ANSI.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths)

$failed = $false
foreach ($path in $Paths) {
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $path).ProviderPath, [ref]$null, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        $failed = $true
        foreach ($e in $errors) {
            Write-Output ("{0}:{1}:{2} {3}" -f $path, $e.Extent.StartLineNumber, $e.Extent.StartColumnNumber, $e.Message)
        }
    } else {
        Write-Output ("parse ok {0}" -f $path)
    }
}
if ($failed) { exit 1 }
exit 0
