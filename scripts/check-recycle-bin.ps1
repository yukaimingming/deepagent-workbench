$shell = New-Object -ComObject Shell.Application
$recycleBin = $shell.Namespace(0xa)
$items = $recycleBin.Items()
Write-Host "Total items in Recycle Bin: $($items.Count)"
foreach ($item in $items) {
    Write-Host "$($item.Name) | $($item.Path)"
}

Write-Host "Checking D:\`$Recycle.Bin..."
Get-ChildItem -Path "D:\`$Recycle.Bin" -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "$($_.FullName)"
}

Write-Host "Checking C:\`$Recycle.Bin..."
Get-ChildItem -Path "C:\`$Recycle.Bin" -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "$($_.FullName)"
}
