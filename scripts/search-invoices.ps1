$keywords = @("*物业*", "*发票*", "*invoice*", "*wuye*")
$roots = @("C:\Users\kaiming yu\Downloads", "C:\Users\kaiming yu\Documents", "C:\Users\kaiming yu\Desktop", "D:\")

foreach ($root in $roots) {
    if (Test-Path $root) {
        Write-Host "Searching in $root..."
        foreach ($kw in $keywords) {
            Get-ChildItem -Path $root -Filter $kw -ErrorAction SilentlyContinue | ForEach-Object {
                Write-Host "  Found: $($_.FullName)"
            }
        }
    }
}
