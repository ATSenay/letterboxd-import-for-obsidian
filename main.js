const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');

const DEFAULT_SETTINGS = {
    tmdbApiKey: '',
    outputFolder: '',
    imageSize: 'w185',
    duplicateHandling: 'append',
    tags: ''
};

class LetterboxdPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.addRibbonIcon('film', 'Import Letterboxd Diary', () => {
            this.importLetterboxdDiary();
        });

        this.addCommand({
            id: 'import-letterboxd-diary',
            name: 'Import Letterboxd Diary CSV',
            callback: () => {
                this.importLetterboxdDiary();
            }
        });

        this.addSettingTab(new LetterboxdSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    sanitizeFilename(filename) {
        return filename.replace(/[\\/*?:"<>|]/g, '-').trim();
    }

    getTagsArray() {
        if (!this.settings.tags || this.settings.tags.trim() === '') {
            return [];
        }
        return this.settings.tags
            .split(',')
            .map(tag => tag.trim())
            .filter(tag => tag.length > 0);
    }

    async getMoviePosterUrl(title) {
        if (!this.settings.tmdbApiKey) {
            return '';
        }

        const searchUrl = "https://api.themoviedb.org/3/search/movie";
        const imageBaseUrl = `https://image.tmdb.org/t/p/${this.settings.imageSize}`;
        
        try {
            const params = new URLSearchParams({
                'api_key': this.settings.tmdbApiKey,
                'query': title
            });

            const response = await fetch(`${searchUrl}?${params}`, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            
            if (data.results && data.results.length > 0) {
                const posterPath = data.results[0].poster_path;
                if (posterPath) {
                    return imageBaseUrl + posterPath;
                }
            }
        } catch (error) {
            console.error(`Error fetching poster for ${title}:`, error);
        }
        
        return '';
    }

    parseCSV(csvContent) {
        const lines = csvContent.trim().split('\n');
        if (lines.length < 2) {
            throw new Error('CSV file must have at least a header row and one data row');
        }

        const headers = lines[0].split(',').map(header => 
            header.replace(/^"(.*)"$/, '$1').trim()
        );

        const rows = [];
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;

            const values = this.parseCSVLine(line);
            
            if (values.length !== headers.length) {
                console.warn(`Row ${i} has ${values.length} values but expected ${headers.length}`);
                continue;
            }

            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index] || '';
            });
            rows.push(row);
        }

        return rows;
    }

    parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const nextChar = line[i + 1];
            
            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        
        result.push(current.trim());
        return result;
    }

    async importLetterboxdDiary() {
        if (!this.settings.tmdbApiKey) {
            new Notice('Please set your TMDB API key in settings first!');
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv';
        input.style.display = 'none';

        input.onchange = async (event) => {
            const target = event.target;
            const file = target.files?.[0];
            
            if (!file) {
                return;
            }

            try {
                const csvContent = await file.text();
                await this.processCsvData(csvContent);
            } catch (error) {
                console.error('Error processing CSV file:', error);
                new Notice(`Error processing CSV file: ${error.message}`);
            }
        };

        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
    }

    async processCsvData(csvContent) {
        try {
            new Notice('Processing Letterboxd diary...');
            
            const rows = this.parseCSV(csvContent);
            console.log('CSV headers found:', Object.keys(rows[0] || {}));

            const outputFolder = this.settings.outputFolder;
            if (!await this.app.vault.adapter.exists(outputFolder)) {
                await this.app.vault.createFolder(outputFolder);
            }

            let count = 0;
            let updated = 0;
            let skipped = 0;
            const total = rows.length;

            for (const row of rows) {
                const title = row['Name'] || row['name'] || row['Title'] || row['title'] || 
                             row['Film'] || row['film'] || row['Movie'] || row['movie'] || '';
                const year = row['Year'] || row['year'] || '';
                const watchedDate = row['Watched Date'] || row['Date'] || row['date'] || '';
                
                if (!title || !title.trim()) {
                    console.warn(`Skipping row ${count + updated + skipped}: no title found. Available columns:`, Object.keys(row));
                    skipped++;
                    continue;
                }
                
                const cleanTitle = title.trim();
                const posterUrl = await this.getMoviePosterUrl(cleanTitle);
                const yearSuffix = year ? ` (${year})` : '';
                const filename = this.sanitizeFilename(cleanTitle) + yearSuffix + '.md';
                const filePath = `${outputFolder}/${filename}`;

                const existingFile = this.app.vault.getAbstractFileByPath(filePath);
                
                if (existingFile && existingFile.path) {
                    if (this.settings.duplicateHandling === 'skip') {
                        skipped++;
                        continue;
                    } else if (this.settings.duplicateHandling === 'append') {
                        const wasAppended = await this.appendWatchEntry(existingFile, row, posterUrl, watchedDate);
                        if (wasAppended !== false) {
                            updated++;
                        } else {
                            skipped++;
                        }
                        continue;
                    } else if (this.settings.duplicateHandling === 'update') {
                        await this.updateMovieFile(existingFile, row, posterUrl);
                        updated++;
                        continue;
                    }
                }

                await this.createNewMovieFile(filePath, row, posterUrl);
                count++;

                if ((count + updated) % 10 === 0) {
                    new Notice(`Processed ${count + updated}/${total} movies...`);
                }
            }

            const summary = `Import complete! Created: ${count}, Updated: ${updated}, Skipped: ${skipped}`;
            new Notice(summary);
            console.log(summary);
            
        } catch (error) {
            console.error('Error processing CSV:', error);
            new Notice(`Error processing CSV: ${error.message}`);
        }
    }

    async createNewMovieFile(filePath, row, posterUrl) {
        let frontmatter = '---\n';
        for (const [key, value] of Object.entries(row)) {
            if (value !== null && value !== undefined && value !== '') {
                const escapedValue = String(value).replace(/'/g, "''");
                frontmatter += `${key}: '${escapedValue}'\n`;
            }
        }
        if (posterUrl) {
            frontmatter += `poster: '${posterUrl}'\n`;
        }
        frontmatter += 'watches: 1\n';
        
        const tags = this.getTagsArray();
        if (tags.length > 0) {
            frontmatter += 'tags:\n';
            tags.forEach(tag => {
                frontmatter += `  - ${tag}\n`;
            });
        }
        
        frontmatter += '---\n\n';

        const content = row['content'] || '';
        const watchedDate = row['Watched Date'] || row['Date'] || '';
        const rating = row['Rating'] || '';
        const review = row['Review'] || '';
        
        let watchHistory = '## Watch History\n\n';
        watchHistory += `### ${watchedDate}\n`;
        if (rating) watchHistory += `**Rating:** ${rating}\n`;
        if (review) watchHistory += `**Review:** ${review}\n`;
        watchHistory += '\n';

        const fileContent = frontmatter + content + '\n\n' + watchHistory;
        await this.app.vault.create(filePath, fileContent);
    }

    async appendWatchEntry(file, row, posterUrl, watchedDate) {
        const content = await this.app.vault.read(file);
        const rating = row['Rating'] || '';
        const review = row['Review'] || '';
        
        if (watchedDate && content.includes(`### ${watchedDate}`)) {
            console.log(`Watch date ${watchedDate} already exists for this movie, skipping duplicate`);
            return false;
        }
        
        let updatedContent = content;
        
        const frontmatterMatch = content.match(/^---\n(.*?)\n---/s);
        if (frontmatterMatch) {
            let frontmatter = frontmatterMatch[1];
            
            if (frontmatter.includes('watches:')) {
                frontmatter = frontmatter.replace(/watches: (\d+)/, (match, count) => {
                    return `watches: ${parseInt(count) + 1}`;
                });
            } else {
                frontmatter += '\nwatches: 2';
            }
            
            if (posterUrl && !frontmatter.includes('poster:')) {
                frontmatter += `\nposter: '${posterUrl}'`;
            }
            
            updatedContent = content.replace(/^---\n.*?\n---/s, `---\n${frontmatter}\n---`);
        }
        
        let newWatchEntry = `### ${watchedDate}\n`;
        if (rating) newWatchEntry += `**Rating:** ${rating}\n`;
        if (review) newWatchEntry += `**Review:** ${review}\n`;
        newWatchEntry += '\n';
        
        if (updatedContent.includes('## Watch History')) {
            updatedContent = updatedContent.replace(
                /(## Watch History\n\n)/,
                `$1${newWatchEntry}`
            );
        } else {
            updatedContent += `\n\n## Watch History\n\n${newWatchEntry}`;
        }
        
        await this.app.vault.modify(file, updatedContent);
        return true;
    }

    async updateMovieFile(file, row, posterUrl) {
        const content = await this.app.vault.read(file);
        
        let existingWatchHistory = '';
        const watchHistoryMatch = content.match(/(## Watch History.*)/s);
        if (watchHistoryMatch) {
            existingWatchHistory = '\n\n' + watchHistoryMatch[1];
        }
        
        let frontmatter = '---\n';
        for (const [key, value] of Object.entries(row)) {
            if (value !== null && value !== undefined && value !== '') {
                const escapedValue = String(value).replace(/'/g, "''");
                frontmatter += `${key}: '${escapedValue}'\n`;
            }
        }
        if (posterUrl) {
            frontmatter += `poster: '${posterUrl}'\n`;
        }
        
        const existingContent = await this.app.vault.read(file);
        const watchCountMatch = existingContent.match(/watches: (\d+)/);
        const watchCount = watchCountMatch ? parseInt(watchCountMatch[1]) + 1 : 1;
        frontmatter += `watches: ${watchCount}\n`;
        
        const tags = this.getTagsArray();
        if (tags.length > 0) {
            frontmatter += 'tags:\n';
            tags.forEach(tag => {
                frontmatter += `  - ${tag}\n`;
            });
        }
        
        frontmatter += '---\n\n';
        
        const newContent = row['content'] || '';
        const fileContent = frontmatter + newContent + existingWatchHistory;
        
        await this.app.vault.modify(file, fileContent);
    }
}

class LetterboxdSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Letterboxd Import Settings' });

        new Setting(containerEl)
            .setName('TMDB API Key')
            .setDesc('Get your free API key from https://www.themoviedb.org/settings/api')
            .addText(text => text
                .setPlaceholder('Enter your TMDB API key')
                .setValue(this.plugin.settings.tmdbApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.tmdbApiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Output Folder')
            .setDesc('Folder where movie files will be created')
            .addText(text => text
                .setPlaceholder('Movies')
                .setValue(this.plugin.settings.outputFolder)
                .onChange(async (value) => {
                    this.plugin.settings.outputFolder = value || 'Movies';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Tags')
            .setDesc('Tags to add to each movie file (comma-separated, e.g., "movie, watched, entertainment"). Leave empty for no tags.')
            .addText(text => text
                .setPlaceholder('movie, watched')
                .setValue(this.plugin.settings.tags)
                .onChange(async (value) => {
                    this.plugin.settings.tags = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Poster Image Size')
            .setDesc('Size of movie posters to fetch from TMDB')
            .addDropdown(dropdown => dropdown
                .addOptions({
                    'w92': 'Small (92px)',
                    'w154': 'Medium (154px)', 
                    'w185': 'Large (185px)',
                    'w342': 'Extra Large (342px)',
                    'w500': 'XXL (500px)',
                    'original': 'Original'
                })
                .setValue(this.plugin.settings.imageSize)
                .onChange(async (value) => {
                    this.plugin.settings.imageSize = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Duplicate Handling')
            .setDesc('How to handle movies you\'ve watched multiple times')
            .addDropdown(dropdown => dropdown
                .addOptions({
                    'append': 'Append new watch to existing file',
                    'update': 'Update existing file with latest info', 
                    'skip': 'Skip movies that already exist'
                })
                .setValue(this.plugin.settings.duplicateHandling)
                .onChange(async (value) => {
                    this.plugin.settings.duplicateHandling = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Usage Instructions' });
        containerEl.createEl('p', { text: '1. Get your free TMDB API key from https://www.themoviedb.org/settings/api' });
        containerEl.createEl('p', { text: '2. Export your diary from Letterboxd (Settings → Import & Export → Export Your Data)' });
        containerEl.createEl('p', { text: '3. Use the ribbon icon or command "Import Letterboxd Diary CSV" to select your diary.csv file' });
        containerEl.createEl('p', { text: '4. Movie files will be created in your specified output folder with poster images and all metadata' });
    }
}

module.exports = LetterboxdPlugin;