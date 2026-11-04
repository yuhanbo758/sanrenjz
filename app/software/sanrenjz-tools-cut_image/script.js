class ImageEditor {
    constructor() {
        this.canvas = document.getElementById('imageCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.originalImage = null;
        this.currentImage = null;
        this.rotation = 0;
        this.flipHorizontal = false;
        this.flipVertical = false;
        this.cropData = null;
        this.textElements = [];
        this.selectedTextElement = null;
        this.isDragging = false;
        this.dragStart = { x: 0, y: 0 };
        this.currentFormat = 'png';
        this.quality = 0.9;
        this.isCropDragging = false;
        this.isResizing = false;
        this.resizeHandle = null;
        this.backgroundImage = null;
        
        // 图片变换属性
        this.imageScale = 1;
        this.imageOffsetX = 0;
        this.imageOffsetY = 0;
        this.isImageDragging = false;
        this.imageDragStart = { x: 0, y: 0 };
        
        // 历史记录系统
        this.history = [];
        this.historyIndex = -1;
        this.maxHistorySize = 20;
        
        this.initializeEventListeners();
        this.loadSystemFonts();
        this.loadUserSettings();
    }
    
    initializeEventListeners() {
        // 文件上传
        const uploadZone = document.getElementById('uploadZone');
        const fileInput = document.getElementById('fileInput');
        const selectImageBtn = document.getElementById('selectImageBtn');
        
        uploadZone.addEventListener('click', () => fileInput.click());
        selectImageBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        
        // 背景图上传
        const backgroundInput = document.getElementById('backgroundInput');
        backgroundInput.addEventListener('change', (e) => this.handleBackgroundSelect(e));
        
        // 在整个窗口接收文件，画布出现后虚线框隐藏也不影响再次拖入。
        const canvasArea = document.querySelector('.canvas-area');
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
            const hasFiles = Array.from(e.dataTransfer?.types || []).includes('Files');
            if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles ? 'copy' : 'none';
            canvasArea.classList.toggle('dragover', hasFiles);
        });
        document.addEventListener('dragleave', (e) => {
            if (!e.relatedTarget) canvasArea.classList.remove('dragover');
        });
        document.addEventListener('drop', (e) => {
            e.preventDefault();
            canvasArea.classList.remove('dragover');
            const files = Array.from(e.dataTransfer?.files || []);
            if (!files.length) return;
            const file = files.find(file => this.isSupportedImage(file));
            if (file) this.loadImage(file);
            else alert('请拖入 JPG、PNG、WebP、GIF 或 BMP 图片文件。');
        });
        document.addEventListener('paste', (e) => {
            if (/^(INPUT|TEXTAREA)$/.test(e.target?.tagName || '') || e.target?.isContentEditable) return;
            const file = Array.from(e.clipboardData?.items || [])
                .find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
            if (file) {
                e.preventDefault();
                this.loadImage(file);
            }
        });
        
        // 工具栏按钮
        document.getElementById('addBackgroundBtn').addEventListener('click', () => this.selectBackground());
        document.getElementById('rotateLeftBtn').addEventListener('click', () => this.rotate(-90));
        document.getElementById('rotateRightBtn').addEventListener('click', () => this.rotate(90));
        document.getElementById('flipHorizontalBtn').addEventListener('click', () => this.flip('horizontal'));
        document.getElementById('flipVerticalBtn').addEventListener('click', () => this.flip('vertical'));
        document.getElementById('resetBtn').addEventListener('click', () => this.resetImage());
        document.getElementById('deleteBtn').addEventListener('click', () => this.deleteImage());
        document.getElementById('cropBtn').addEventListener('click', () => this.applyCrop());
        
        // 撤销和重做按钮
        document.getElementById('undoBtn').addEventListener('click', () => this.undo());
        document.getElementById('redoBtn').addEventListener('click', () => this.redo());
        
        // 键盘快捷键
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                this.undo();
            } else if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'Z')) {
                e.preventDefault();
                this.redo();
            }
        });
        
        // 尺寸预设
        document.querySelectorAll('.size-btn').forEach(btn => {
            btn.addEventListener('click', () => this.selectSizePreset(btn));
        });
        
        // 文字工具
        document.getElementById('addTextBtn').addEventListener('click', () => this.addText());
        document.getElementById('deleteTextBtn').addEventListener('click', () => this.deleteSelectedText());
        document.getElementById('textContent').addEventListener('input', () => this.updateSelectedText());
        document.getElementById('textContent').addEventListener('blur', () => this.saveState('编辑文字内容'));
        document.getElementById('fontFamily').addEventListener('change', () => {
            this.updateSelectedText();
            this.saveState('修改字体');
        });
        document.getElementById('fontSize').addEventListener('input', () => this.updateSelectedText());
        document.getElementById('fontSize').addEventListener('change', () => this.saveState('修改字号'));
        document.getElementById('textColor').addEventListener('input', () => this.updateSelectedText());
        document.getElementById('textColor').addEventListener('change', () => this.saveState('修改文字颜色'));
        document.getElementById('textOpacity').addEventListener('input', () => this.updateSelectedText());
        document.getElementById('textOpacity').addEventListener('change', () => this.saveState('修改文字透明度'));
        
        // 文字样式保存和加载
        document.getElementById('saveTextStyleBtn').addEventListener('click', () => this.saveTextStyle());
        
        // 艺术字效果控件事件监听器
        this.initializeArtTextControls();
        
        // 文字输入框键盘事件（Ctrl+回车换行）
        document.getElementById('textContent').addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                const textarea = e.target;
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const value = textarea.value;
                textarea.value = value.substring(0, start) + '\n' + value.substring(end);
                textarea.selectionStart = textarea.selectionEnd = start + 1;
                this.updateSelectedText();
            }
        });
        
        // 字号控制按钮
        document.getElementById('decreaseFontBtn').addEventListener('click', () => this.adjustFontSize(-2));
        document.getElementById('increaseFontBtn').addEventListener('click', () => this.adjustFontSize(2));
        
        // 字体样式控件
        document.getElementById('fontBold').addEventListener('change', () => {
            this.updateSelectedText();
            this.saveState('修改文字粗体');
        });
        document.getElementById('fontItalic').addEventListener('change', () => {
            this.updateSelectedText();
            this.saveState('修改文字斜体');
        });
        
        // 导出设置
        document.querySelectorAll('.format-btn').forEach(btn => {
            btn.addEventListener('click', () => this.selectFormat(btn));
        });
        
        const qualitySlider = document.getElementById('quality');
        qualitySlider.addEventListener('input', () => {
            this.quality = qualitySlider.value / 100;
            document.getElementById('qualityValue').textContent = qualitySlider.value;
            this.saveUserSettings();
        });
        
        document.getElementById('downloadBtn').addEventListener('click', () => this.downloadImage());
        
        // 分辨率设置
        document.getElementById('resolutionScale').addEventListener('change', () => this.saveUserSettings());
        
        // 画布事件
        this.canvas.addEventListener('mousedown', (e) => this.handleCanvasMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleCanvasMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this.handleCanvasMouseUp());
        this.canvas.addEventListener('wheel', (e) => this.handleCanvasWheel(e));
        
        // 裁剪框事件
        const cropOverlay = document.getElementById('cropOverlay');
        cropOverlay.addEventListener('mousedown', (e) => this.handleCropMouseDown(e));
        document.addEventListener('mousemove', (e) => this.handleDocumentMouseMove(e));
        document.addEventListener('mouseup', () => this.handleDocumentMouseUp());
        
        // 自定义尺寸输入
        document.getElementById('cropWidth').addEventListener('input', () => this.updateCustomSize('width'));
        document.getElementById('cropHeight').addEventListener('input', () => this.updateCustomSize('height'));
    }
    
    async loadSystemFonts() {
        const fontSelect = document.getElementById('fontFamily');
        let availableFonts = [];
        
        try {
            // 1. 尝试使用现代浏览器的字体API
            if ('queryLocalFonts' in window) {
                const fonts = await window.queryLocalFonts();
                availableFonts = [...new Set(fonts.map(font => font.family))].sort();
            }
        } catch (error) {
            console.log('Native Font API not available');
        }

        // 2. 如果原生API失败，尝试使用 Electron/Node 服务获取
        if (availableFonts.length === 0 && window.services && window.services.getSystemFonts) {
            try {
                const systemFonts = window.services.getSystemFonts();
                if (systemFonts && systemFonts.length > 0) {
                    availableFonts = systemFonts;
                }
            } catch (e) {
                console.error('Failed to get system fonts from service:', e);
            }
        }
        
        // 3. 回退方案：检测常见系统字体
        if (availableFonts.length === 0) {
            const systemFonts = [
            // 中文字体
            'Microsoft YaHei', 'Microsoft YaHei UI', 'SimSun', 'SimHei', 'KaiTi', 'FangSong', 
            'LiSu', 'YouYuan', 'Microsoft JhengHei', 'PMingLiU', 'MingLiU', 'DFKai-SB', 
            'STSong', 'STHeiti', 'STKaiti', 'STFangsong', 'STZhongsong', 'STLiti', 'STXihei', 
            'STXingkai', 'NSimSun', 'SimSun-ExtB', 'MingLiU-ExtB', 'PMingLiU-ExtB',
            // 英文字体
            'Arial', 'Times New Roman', 'Helvetica', 'Georgia', 'Verdana', 'Tahoma',
            'Trebuchet MS', 'Impact', 'Comic Sans MS', 'Courier New', 'Palatino',
            'Garamond', 'Bookman', 'Avant Garde', 'Calibri', 'Cambria', 'Candara',
            'Century Gothic', 'Franklin Gothic Medium', 'Lucida Console', 'Segoe UI',
            'Consolas', 'Monaco', 'Menlo', 'Ubuntu', 'Roboto', 'Open Sans', 'Lato',
            'Source Sans Pro', 'Montserrat', 'Oswald', 'Raleway', 'PT Sans', 'Lora'
        ];
            
            for (const font of systemFonts) {
                if (await this.isFontAvailable(font)) {
                    availableFonts.push(font);
                }
            }
        }
        
        fontSelect.innerHTML = '';
        
        // 按字体类型分组显示
        const chineseFonts = availableFonts.filter(font => 
            /^(Microsoft|SimSun|SimHei|KaiTi|FangSong|LiSu|YouYuan|PMingLiU|MingLiU|DFKai|ST|NSimSun)/.test(font)
        );
        const englishFonts = availableFonts.filter(font => !chineseFonts.includes(font));
        
        // 添加中文字体组
        if (chineseFonts.length > 0) {
            const chineseGroup = document.createElement('optgroup');
            chineseGroup.label = '中文字体';
            chineseFonts.forEach(font => {
                const option = document.createElement('option');
                option.value = font;
                option.textContent = font;
                chineseGroup.appendChild(option);
            });
            fontSelect.appendChild(chineseGroup);
        }
        
        // 添加英文字体组
        if (englishFonts.length > 0) {
            const englishGroup = document.createElement('optgroup');
            englishGroup.label = '英文字体';
            englishFonts.forEach(font => {
                const option = document.createElement('option');
                option.value = font;
                option.textContent = font;
                englishGroup.appendChild(option);
            });
            fontSelect.appendChild(englishGroup);
        }
    }
    
    // 检测字体是否可用
    async isFontAvailable(fontName) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // 使用默认字体绘制文本
        ctx.font = '12px monospace';
        const defaultWidth = ctx.measureText('test').width;
        
        // 使用指定字体绘制文本
        ctx.font = `12px "${fontName}", monospace`;
        const testWidth = ctx.measureText('test').width;
        
        // 如果宽度不同，说明字体可用
        return defaultWidth !== testWidth;
    }
    
    handleFileSelect(e) {
        const file = e.target.files[0];
        if (file) {
            this.loadImage(file);
        }
        e.target.value = '';
    }

    isSupportedImage(file) {
        return !!file && (/^image\/(jpeg|png|webp|gif|bmp|x-ms-bmp)$/i.test(file.type || '') ||
            /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name || ''));
    }
    
    loadImage(file) {
        if (!this.isSupportedImage(file)) {
            alert('请选择有效的图片文件！');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                if (!img.naturalWidth || !img.naturalHeight) return;
                const keepBackground = !this.currentImage;
                this.originalImage = img;
                this.currentImage = img;
                this.rotation = 0;
                this.flipHorizontal = false;
                this.flipVertical = false;
                this.backgroundImage = keepBackground ? this.backgroundImage : null;
                this.cropData = null;
                this.hideCropOverlay();
                document.querySelectorAll('.size-btn').forEach(btn => btn.classList.remove('active'));
                document.getElementById('cropWidth').value = '';
                document.getElementById('cropHeight').value = '';
                this.selectedRatio = null;
                this.textElements = [];
                this.selectedTextElement = null;
                this.hideTextControls();
                
                // 重置图片缩放和位置
                this.imageScale = 1;
                this.imageOffsetX = 0;
                this.imageOffsetY = 0;
                
                this.showCanvas();
                this.setupCanvas();
                this.updateImageInfo();
                
                // 保存初始状态
                this.history = [];
                this.historyIndex = -1;
                this.saveState('加载图片');
            };
            img.onerror = () => alert('图片解码失败，请选择有效的图片文件。');
            img.src = e.target.result;
        };
        reader.onerror = () => alert('读取图片失败，请检查文件是否可访问。');
        reader.readAsDataURL(file);
    }

    updateImageInfo() {
        const info = document.getElementById('imageInfo');
        const source = this.currentImage;
        info.textContent = source
            ? `图片 ${source.naturalWidth || source.width} × ${source.naturalHeight || source.height} px · 当前画布 ${this.canvas.width} × ${this.canvas.height} px`
            : '尚未加载图片';
    }
    
    setupCanvas() {
        // 获取容器的实际可用尺寸
        const container = document.getElementById('canvasContainer');
        const containerRect = container.getBoundingClientRect();
        
        // 计算最大可用尺寸（减去较少的边距，充分利用空间）
        const maxCanvasWidth = Math.max(1, containerRect.width - 20);
        const maxCanvasHeight = Math.max(1, containerRect.height - 20);
        
        let canvasWidth, canvasHeight;
        
        if (this.backgroundImage) {
            // 有背景图时，根据背景图比例计算尺寸，支持2倍显示
            const aspectRatio = this.backgroundImage.width / this.backgroundImage.height;
            
            // 优先使用2倍尺寸，但不超过容器限制
            const preferredWidth = Math.min(this.backgroundImage.width * 2, maxCanvasWidth);
            const preferredHeight = Math.min(this.backgroundImage.height * 2, maxCanvasHeight);
            
            // 按比例适配
            canvasWidth = preferredWidth;
            canvasHeight = canvasWidth / aspectRatio;
            
            // 如果高度超过限制，按高度重新计算
            if (canvasHeight > maxCanvasHeight) {
                canvasHeight = maxCanvasHeight;
                canvasWidth = canvasHeight * aspectRatio;
            }
        } else if (this.currentImage) {
            // 没有背景图但有主图时，根据主图比例计算尺寸，支持2倍显示
            const rotatedDims = this.getRotatedDimensions();
            const aspectRatio = rotatedDims.width / rotatedDims.height;
            
            // 优先使用2倍尺寸，但不超过容器限制
            const preferredWidth = Math.min(rotatedDims.width * 2, maxCanvasWidth);
            const preferredHeight = Math.min(rotatedDims.height * 2, maxCanvasHeight);
            
            // 按比例适配
            canvasWidth = preferredWidth;
            canvasHeight = canvasWidth / aspectRatio;
            
            // 如果高度超过限制，按高度重新计算
            if (canvasHeight > maxCanvasHeight) {
                canvasHeight = maxCanvasHeight;
                canvasWidth = canvasHeight * aspectRatio;
            }
        } else {
            // 都没有时，使用600x600的默认尺寸
            canvasWidth = 600;
            canvasHeight = 600;
        }
        
        this.canvas.width = canvasWidth;
        this.canvas.height = canvasHeight;
        
        this.drawImage();
        this.updateImageInfo();
    }
    
    getRotatedDimensions() {
        const { width, height } = this.currentImage;
        if (this.rotation % 180 === 0) {
            return { width, height };
        } else {
            return { width: height, height: width };
        }
    }
    
    getMainImageRect() {
        if (!this.currentImage) return null;
        
        let drawWidth, drawHeight;
        
        if (!this.backgroundImage) {
            // 没有背景图时，主图直接填充整个画布
            drawWidth = this.canvas.width * this.imageScale;
            drawHeight = this.canvas.height * this.imageScale;
        } else {
            // 有背景图时，主图需要适配缩放
            const baseScale = Math.min(
                this.canvas.width / this.currentImage.width,
                this.canvas.height / this.currentImage.height
            );
            
            // 应用用户缩放
            const finalScale = baseScale * this.imageScale;
            
            drawWidth = this.currentImage.width * finalScale;
            drawHeight = this.currentImage.height * finalScale;
        }
        
        // 计算主图的位置（考虑偏移）
        const centerX = this.canvas.width / 2 + this.imageOffsetX;
        const centerY = this.canvas.height / 2 + this.imageOffsetY;
        
        return {
            left: centerX - drawWidth / 2,
            top: centerY - drawHeight / 2,
            right: centerX + drawWidth / 2,
            bottom: centerY + drawHeight / 2,
            width: drawWidth,
            height: drawHeight
        };
    }
    
    getTextElementAtPosition(x, y) {
        // 从后往前检查文字元素（后面的在上层）
        for (let i = this.textElements.length - 1; i >= 0; i--) {
            const textEl = this.textElements[i];
            
            // 构建字体样式字符串（与绘制时保持一致）
            let fontStyle = '';
            if (textEl.fontItalic) fontStyle += 'italic ';
            if (textEl.fontBold) fontStyle += 'bold ';
            fontStyle += `${textEl.fontSize}px ${textEl.fontFamily}`;
            
            this.ctx.font = fontStyle;
            
            // 计算多行文字的边界
            const lines = textEl.content.split('\n');
            const lineHeight = textEl.fontSize * 1.2; // 行高为字体大小的1.2倍
            
            // 计算文字边界框
            let maxWidth = 0;
            lines.forEach(line => {
                const textWidth = this.ctx.measureText(line).width;
                maxWidth = Math.max(maxWidth, textWidth);
            });
            
            const totalHeight = lines.length * lineHeight;
            const textX = textEl.x;
            const textY = textEl.y - textEl.fontSize; // 调整Y坐标到文字顶部
            
            // 检查点击是否在文字边界内（包含5px的边距）
            if (x >= textX - 5 && x <= textX + maxWidth + 5 &&
                y >= textY - 5 && y <= textY + totalHeight + 5) {
                return textEl;
            }
        }
        
        return null;
    }
    
    drawImage(showBorders = true) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 绘制背景图（如果有）
        if (this.backgroundImage) {
            if (!this.currentImage) {
                // 只有背景图时，直接绘制背景图填充整个画布
                this.ctx.drawImage(
                    this.backgroundImage,
                    0, 0,
                    this.canvas.width, this.canvas.height
                );
            } else {
                // 有主图时，背景图适配画布尺寸并居中显示
                const bgScale = Math.min(
                    this.canvas.width / this.backgroundImage.width,
                    this.canvas.height / this.backgroundImage.height
                );
                const bgWidth = this.backgroundImage.width * bgScale;
                const bgHeight = this.backgroundImage.height * bgScale;
                const bgX = (this.canvas.width - bgWidth) / 2;
                const bgY = (this.canvas.height - bgHeight) / 2;
                
                this.ctx.drawImage(
                    this.backgroundImage,
                    bgX, bgY,
                    bgWidth, bgHeight
                );
            }
        }
        
        // 只有在有主图时才绘制主图
        if (this.currentImage) {
            this.ctx.save();
            
            // 应用图片偏移
            this.ctx.translate(this.canvas.width / 2 + this.imageOffsetX, this.canvas.height / 2 + this.imageOffsetY);
            this.ctx.rotate((this.rotation * Math.PI) / 180);
            this.ctx.scale(this.flipHorizontal ? -1 : 1, this.flipVertical ? -1 : 1);
            
            let drawWidth, drawHeight;
            
            if (!this.backgroundImage) {
                // 没有背景图时，主图直接填充整个画布
                drawWidth = this.canvas.width * this.imageScale;
                drawHeight = this.canvas.height * this.imageScale;
            } else {
                // 有背景图时，主图需要适配缩放
                const baseScale = Math.min(
                    this.canvas.width / this.currentImage.width,
                    this.canvas.height / this.currentImage.height
                );
                
                // 应用用户缩放
                const finalScale = baseScale * this.imageScale;
                
                drawWidth = this.currentImage.width * finalScale;
                drawHeight = this.currentImage.height * finalScale;
            }
            
            this.ctx.drawImage(
                this.currentImage,
                -drawWidth / 2,
                -drawHeight / 2,
                drawWidth,
                drawHeight
            );

            // 绘制图片虚线边框（仅在显示模式下）
            if (showBorders) {
                this.ctx.setLineDash([5, 5]);
                this.ctx.strokeStyle = '#007bff';
                this.ctx.lineWidth = 2;
                this.ctx.strokeRect(
                    -drawWidth / 2,
                    -drawHeight / 2,
                    drawWidth,
                    drawHeight
                );
                this.ctx.setLineDash([]); // 重置虚线
            }

            this.ctx.restore();
        }
        
        // 绘制文字元素
        this.drawTextElements(showBorders);
    }
    
    drawTextElements(showBorders = true) {
        this.textElements.forEach(textEl => {
            this.ctx.save();
            
            // 构建字体样式字符串
            let fontStyle = '';
            if (textEl.fontItalic) fontStyle += 'italic ';
            if (textEl.fontBold) fontStyle += 'bold ';
            fontStyle += `${textEl.fontSize}px ${textEl.fontFamily}`;
            
            this.ctx.font = fontStyle;
            this.ctx.globalAlpha = textEl.opacity;
            
            // 处理多行文字
            const lines = textEl.content.split('\n');
            const lineHeight = textEl.fontSize * 1.2; // 行高为字体大小的1.2倍
            
            // 绘制文字虚线边框（仅在显示模式下）
            if (showBorders) {
                // 计算文字边界框
                let maxWidth = 0;
                lines.forEach(line => {
                    const textWidth = this.ctx.measureText(line).width;
                    maxWidth = Math.max(maxWidth, textWidth);
                });
                
                const totalHeight = lines.length * lineHeight;
                const textX = textEl.x;
                const textY = textEl.y - textEl.fontSize; // 调整Y坐标到文字顶部
                
                this.ctx.save();
                this.ctx.globalAlpha = 0.8;
                this.ctx.setLineDash([3, 3]);
                this.ctx.strokeStyle = '#28a745';
                this.ctx.lineWidth = 1;
                this.ctx.strokeRect(
                    textX - 5,
                    textY - 5,
                    maxWidth + 10,
                    totalHeight + 10
                );
                this.ctx.setLineDash([]); // 重置虚线
                this.ctx.restore();
            }
            
            // 绘制艺术字效果
            lines.forEach((line, index) => {
                const yPos = textEl.y + index * lineHeight;
                this.drawArtText(line, textEl.x, yPos, textEl);
            });
            
            this.ctx.restore();
        });
    }
    
    drawArtText(text, x, y, textEl) {
        this.ctx.save();
        
        // 设置阴影效果
        if (textEl.shadowEnabled) {
            this.ctx.shadowColor = textEl.shadowColor;
            this.ctx.shadowOffsetX = textEl.shadowX;
            this.ctx.shadowOffsetY = textEl.shadowY;
            this.ctx.shadowBlur = textEl.shadowBlur;
        }
        
        // 设置发光效果（使用多重阴影模拟）
        if (textEl.glowEnabled && !textEl.shadowEnabled) {
            this.ctx.shadowColor = textEl.glowColor;
            this.ctx.shadowBlur = textEl.glowIntensity;
            this.ctx.shadowOffsetX = 0;
            this.ctx.shadowOffsetY = 0;
        }
        
        // 绘制发光效果的多层阴影
        if (textEl.glowEnabled) {
            const originalShadow = {
                color: this.ctx.shadowColor,
                blur: this.ctx.shadowBlur,
                offsetX: this.ctx.shadowOffsetX,
                offsetY: this.ctx.shadowOffsetY
            };
            
            // 绘制多层发光效果
            for (let i = 0; i < 3; i++) {
                this.ctx.save();
                this.ctx.shadowColor = textEl.glowColor;
                this.ctx.shadowBlur = textEl.glowIntensity + i * 5;
                this.ctx.shadowOffsetX = 0;
                this.ctx.shadowOffsetY = 0;
                this.ctx.globalAlpha = 0.3 - i * 0.1;
                
                // 先绘制描边（如果启用）
                if (textEl.strokeEnabled) {
                    this.ctx.strokeStyle = textEl.strokeColor;
                    this.ctx.lineWidth = textEl.strokeWidth;
                    this.ctx.lineJoin = 'round';
                    this.ctx.lineCap = 'round';
                    this.ctx.strokeText(text, x, y);
                }
                
                // 再绘制填充
                if (textEl.gradientEnabled) {
                    this.ctx.fillStyle = this.createTextGradient(textEl, x, y, text);
                } else {
                    this.ctx.fillStyle = textEl.color;
                }
                this.ctx.fillText(text, x, y);
                this.ctx.restore();
            }
            
            // 恢复原始阴影设置
            this.ctx.shadowColor = originalShadow.color;
            this.ctx.shadowBlur = originalShadow.blur;
            this.ctx.shadowOffsetX = originalShadow.offsetX;
            this.ctx.shadowOffsetY = originalShadow.offsetY;
        }
        
        // 主要文字绘制：先描边，后填充
        
        // 1. 先绘制描边效果（底层）
        if (textEl.strokeEnabled) {
            this.ctx.save();
            this.ctx.strokeStyle = textEl.strokeColor;
            this.ctx.lineWidth = textEl.strokeWidth;
            this.ctx.lineJoin = 'round';
            this.ctx.lineCap = 'round';
            // 描边不需要阴影效果，清除阴影
            this.ctx.shadowColor = 'transparent';
            this.ctx.shadowBlur = 0;
            this.ctx.shadowOffsetX = 0;
            this.ctx.shadowOffsetY = 0;
            this.ctx.strokeText(text, x, y);
            this.ctx.restore();
        }
        
        // 2. 再绘制文字填充（顶层）
        this.ctx.save();
        // 设置填充样式（渐变或纯色）
        if (textEl.gradientEnabled) {
            this.ctx.fillStyle = this.createTextGradient(textEl, x, y, text);
        } else {
            this.ctx.fillStyle = textEl.color;
        }
        
        // 绘制主要文字（保持阴影效果）
        this.ctx.fillText(text, x, y);
        this.ctx.restore();
        
        this.ctx.restore();
    }
    
    createTextGradient(textEl, x, y, text = null) {
        let gradient;
        // 如果提供了text参数，使用它；否则使用textEl.content
        const textToMeasure = text || textEl.content;
        const textMetrics = this.ctx.measureText(textToMeasure);
        const textWidth = textMetrics.width;
        const textHeight = textEl.fontSize;
        
        switch (textEl.gradientDirection) {
            case 'horizontal':
                gradient = this.ctx.createLinearGradient(x, y, x + textWidth, y);
                break;
            case 'vertical':
                gradient = this.ctx.createLinearGradient(x, y - textHeight, x, y);
                break;
            case 'diagonal1': // 左上到右下
                gradient = this.ctx.createLinearGradient(x, y - textHeight, x + textWidth, y);
                break;
            case 'diagonal2': // 左下到右上
                gradient = this.ctx.createLinearGradient(x, y, x + textWidth, y - textHeight);
                break;
            default:
                gradient = this.ctx.createLinearGradient(x, y - textHeight, x, y);
        }
        
        gradient.addColorStop(0, textEl.gradientColor1);
        gradient.addColorStop(1, textEl.gradientColor2);
        
        return gradient;
    }
    
    showCanvas() {
        document.getElementById('uploadZone').style.display = 'none';
        const container = document.getElementById('canvasContainer');
        container.classList.add('active');
    }
    
    hideCanvas() {
        document.getElementById('uploadZone').style.display = 'flex';
        const container = document.getElementById('canvasContainer');
        container.classList.remove('active');
    }
    
    rotate(degrees) {
        if (!this.currentImage) return;
        this.rotation = (this.rotation + degrees) % 360;
        this.hideCropOverlay();
        this.setupCanvas();
        this.saveState(`旋转${degrees > 0 ? '右' : '左'}转`);
    }

    flip(direction) {
        if (!this.currentImage) return;
        if (direction === 'horizontal') this.flipHorizontal = !this.flipHorizontal;
        else this.flipVertical = !this.flipVertical;
        this.drawImage();
        this.saveState(direction === 'horizontal' ? '水平翻转' : '垂直翻转');
    }

    resetImage() {
        if (!this.originalImage) return;
        this.currentImage = this.originalImage;
        this.backgroundImage = null;
        this.rotation = 0;
        this.flipHorizontal = false;
        this.flipVertical = false;
        this.imageScale = 1;
        this.imageOffsetX = 0;
        this.imageOffsetY = 0;
        this.textElements = [];
        this.selectedTextElement = null;
        this.hideTextControls();
        this.hideCropOverlay();
        this.setupCanvas();
        this.saveState('重置图片');
    }
    

    
    selectSizePreset(btn) {
        document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const ratio = btn.dataset.ratio;
        const width = btn.dataset.width;
        const height = btn.dataset.height;
        const widthInput = document.getElementById('cropWidth');
        const heightInput = document.getElementById('cropHeight');
        
        // 保存当前选择的比例和固定尺寸
        this.selectedRatio = ratio;
        this.fixedWidth = width ? parseInt(width) : null;
        this.fixedHeight = height ? parseInt(height) : null;
        
        if (ratio === 'custom' || ratio === 'free') {
            this.selectedRatio = null;
            this.fixedWidth = null;
            this.fixedHeight = null;
            widthInput.value = '';
            heightInput.value = '';
            this.hideCropOverlay();
            return;
        }
        
        let cropWidth, cropHeight;
        
        if (this.fixedWidth && this.fixedHeight) {
            // 固定尺寸
            cropWidth = this.fixedWidth;
            cropHeight = this.fixedHeight;
        } else {
            // 比例尺寸
            const [w, h] = ratio.split(':').map(Number);
            const baseSize = 300;
            
            if (w > h) {
                cropWidth = baseSize;
                cropHeight = Math.round(baseSize * h / w);
            } else {
                cropHeight = baseSize;
                cropWidth = Math.round(baseSize * w / h);
            }
        }
        
        widthInput.value = cropWidth;
        heightInput.value = cropHeight;
        
        // 显示裁剪预览框
        this.showCropOverlay(cropWidth, cropHeight);
    }
    
    updateCustomSize(changedField = null) {
        document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.size-btn[data-ratio="custom"]').classList.add('active');
        
        const widthInput = document.getElementById('cropWidth');
        const heightInput = document.getElementById('cropHeight');
        let width = parseInt(widthInput.value);
        let height = parseInt(heightInput.value);
        
        // 如果有选定的比例，保持比例约束
        if (this.selectedRatio && this.selectedRatio !== 'custom' && this.selectedRatio !== 'free' && changedField) {
            if (this.fixedWidth && this.fixedHeight) {
                // 固定尺寸，按比例缩放
                const ratio = this.fixedWidth / this.fixedHeight;
                if (changedField === 'width' && width > 0) {
                    height = Math.round(width / ratio);
                    heightInput.value = height;
                } else if (changedField === 'height' && height > 0) {
                    width = Math.round(height * ratio);
                    widthInput.value = width;
                }
            } else {
                // 比例约束
                const [w, h] = this.selectedRatio.split(':').map(Number);
                const ratio = w / h;
                if (changedField === 'width' && width > 0) {
                    height = Math.round(width / ratio);
                    heightInput.value = height;
                } else if (changedField === 'height' && height > 0) {
                    width = Math.round(height * ratio);
                    widthInput.value = width;
                }
            }
        }
        
        if (width && height) {
            this.showCropOverlay(width, height);
        } else {
            this.hideCropOverlay();
        }
    }
    
    showCropOverlay(width, height) {
        if (!this.currentImage) return;
        
        const overlay = document.getElementById('cropOverlay');
        const canvasContainer = document.getElementById('canvasContainer');
        
        // 计算裁剪框的位置和大小
        const canvasRect = this.canvas.getBoundingClientRect();
        const containerRect = canvasContainer.getBoundingClientRect();
        
        // 计算缩放比例
        const scaleX = this.canvas.width / canvasRect.width;
        const scaleY = this.canvas.height / canvasRect.height;
        
        // 允许裁剪框与画布区域保持一致，不限制最大尺寸
        let displayWidth = width;
        let displayHeight = height;
        
        // 如果裁剪尺寸超过画布，按比例缩放以适应画布
        const maxWidth = this.canvas.width;
        const maxHeight = this.canvas.height;
        
        if (displayWidth > maxWidth || displayHeight > maxHeight) {
            const scaleToFit = Math.min(maxWidth / displayWidth, maxHeight / displayHeight);
            displayWidth = displayWidth * scaleToFit;
            displayHeight = displayHeight * scaleToFit;
        }
        
        // 保持宽高比
        const aspectRatio = width / height;
        if (displayWidth / displayHeight > aspectRatio) {
            displayWidth = displayHeight * aspectRatio;
        } else {
            displayHeight = displayWidth / aspectRatio;
        }
        
        // 转换为屏幕坐标
        const screenWidth = displayWidth / scaleX;
        const screenHeight = displayHeight / scaleY;
        
        // 计算画布在容器中的位置
        const canvasOffsetX = canvasRect.left - containerRect.left;
        const canvasOffsetY = canvasRect.top - containerRect.top;
        
        // 居中显示（相对于画布位置）
        const left = canvasOffsetX + (canvasRect.width - screenWidth) / 2;
        const top = canvasOffsetY + (canvasRect.height - screenHeight) / 2;
        
        overlay.style.left = left + 'px';
        overlay.style.top = top + 'px';
        overlay.style.width = screenWidth + 'px';
        overlay.style.height = screenHeight + 'px';
        overlay.classList.add('active');
        
        // 清除之前的网格线
        const existingGrid = overlay.querySelector('.grid-lines');
        if (existingGrid) {
            existingGrid.remove();
        }
        
        // 创建16格网格线
        this.createGridLines(overlay, screenWidth, screenHeight);
        
        // 存储裁剪数据
        this.cropData = {
            x: (this.canvas.width - displayWidth) / 2,
            y: (this.canvas.height - displayHeight) / 2,
            width: displayWidth,
            height: displayHeight
        };
    }
    
    createGridLines(overlay, width, height) {
        const gridContainer = document.createElement('div');
        gridContainer.className = 'grid-lines';
        gridContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1;
        `;
        
        // 创建4x4网格（16格）
        const gridSize = 4;
        const cellWidth = width / gridSize;
        const cellHeight = height / gridSize;
        
        // 创建垂直线
        for (let i = 1; i < gridSize; i++) {
            const line = document.createElement('div');
            line.style.cssText = `
                position: absolute;
                left: ${i * cellWidth}px;
                top: 0;
                width: 1px;
                height: 100%;
                background: rgba(255, 255, 255, 0.6);
                border-left: 1px dashed rgba(0, 0, 0, 0.4);
            `;
            gridContainer.appendChild(line);
        }
        
        // 创建水平线
        for (let i = 1; i < gridSize; i++) {
            const line = document.createElement('div');
            line.style.cssText = `
                position: absolute;
                left: 0;
                top: ${i * cellHeight}px;
                width: 100%;
                height: 1px;
                background: rgba(255, 255, 255, 0.6);
                border-top: 1px dashed rgba(0, 0, 0, 0.4);
            `;
            gridContainer.appendChild(line);
        }
        
        overlay.appendChild(gridContainer);
    }
    
    hideCropOverlay() {
        const overlay = document.getElementById('cropOverlay');
        overlay.classList.remove('active');
        
        // 清除网格线
        const existingGrid = overlay.querySelector('.grid-lines');
        if (existingGrid) {
            existingGrid.remove();
        }
        
        this.cropData = null;
    }
    
    applyCrop() {
        if (!this.currentImage) return;
        
        let cropData = this.cropData;
        if (!cropData) {
            // 如果没有裁剪预览，使用输入框的值，如果输入框为空则使用整个画布
            const widthInput = document.getElementById('cropWidth');
            const heightInput = document.getElementById('cropHeight');
            const cropWidth = parseInt(widthInput.value) || this.canvas.width;
            const cropHeight = parseInt(heightInput.value) || this.canvas.height;
            
            // 允许裁剪区域等于或小于画布尺寸
            const finalWidth = Math.min(cropWidth, this.canvas.width);
            const finalHeight = Math.min(cropHeight, this.canvas.height);
            
            cropData = {
                x: Math.max(0, (this.canvas.width - finalWidth) / 2),
                y: Math.max(0, (this.canvas.height - finalHeight) / 2),
                width: finalWidth,
                height: finalHeight
            };
        }
        
        // 创建新的画布进行裁剪
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        
        tempCanvas.width = cropData.width;
        tempCanvas.height = cropData.height;
        
        // 裁剪时重绘无编辑边框的内容，避免将蓝色虚线烘焙进图片。
        this.drawImage(false);
        tempCtx.drawImage(
            this.canvas,
            cropData.x, cropData.y, cropData.width, cropData.height,
            0, 0, cropData.width, cropData.height
        );
        
        // 更新当前图片
        const img = new Image();
        img.onload = () => {
            this.currentImage = img;
            // 裁剪后清除背景图，因为裁剪后的内容就是最终结果
            this.backgroundImage = null;
            // 重置图片变换属性
            this.rotation = 0;
            this.imageScale = 1;
            this.imageOffsetX = 0;
            this.imageOffsetY = 0;
            // 清空文字元素，因为裁剪后文字已经合并到图片中
            this.textElements = [];
            this.selectedTextElement = null;
            this.hideTextControls();
            this.hideCropOverlay();
            this.setupCanvas();
            this.saveState('裁剪图片');
        };
        img.src = tempCanvas.toDataURL();
    }
    
    addText() {
        // 允许在有背景图或主图时添加文字
        if (!this.currentImage && !this.backgroundImage) return;
        
        // 尝试加载保存的文字样式
        const savedStyle = this.getSavedTextStyle();
        
        const textElement = {
            id: Date.now(),
            content: '双击编辑文字',
            x: this.canvas.width / 2,
            y: this.canvas.height / 2,
            fontSize: savedStyle?.fontSize || 24,
            fontFamily: savedStyle?.fontFamily || 'Microsoft YaHei',
            color: savedStyle?.color || '#000000',
            opacity: savedStyle?.opacity || 1,
            // 字体样式
            fontBold: savedStyle?.fontBold || false,
            fontItalic: savedStyle?.fontItalic || false,
            // 艺术字效果属性
            strokeEnabled: savedStyle?.strokeEnabled || false,
            strokeColor: savedStyle?.strokeColor || '#ffffff',
            strokeWidth: savedStyle?.strokeWidth || 2,
            shadowEnabled: savedStyle?.shadowEnabled || false,
            shadowColor: savedStyle?.shadowColor || '#000000',
            shadowX: savedStyle?.shadowX || 2,
            shadowY: savedStyle?.shadowY || 2,
            shadowBlur: savedStyle?.shadowBlur || 4,
            glowEnabled: savedStyle?.glowEnabled || false,
            glowColor: savedStyle?.glowColor || '#00ffff',
            glowIntensity: savedStyle?.glowIntensity || 10,
            gradientEnabled: savedStyle?.gradientEnabled || false,
            gradientColor1: savedStyle?.gradientColor1 || '#ff0000',
            gradientColor2: savedStyle?.gradientColor2 || '#0000ff',
            gradientDirection: savedStyle?.gradientDirection || 'vertical'
        };
        
        this.textElements.push(textElement);
        this.selectedTextElement = textElement;
        this.showTextControls();
        this.updateTextControls();
        this.drawImage();
        this.saveState('添加文字');
    }
    
    saveTextStyle() {
        const style = {
            fontSize: parseInt(document.getElementById('fontSize').value) || 24,
            fontFamily: document.getElementById('fontFamily').value || 'Microsoft YaHei',
            color: document.getElementById('textColor').value || '#000000',
            opacity: parseFloat(document.getElementById('textOpacity').value) || 1,
            // 字体样式
            fontBold: document.getElementById('fontBold').checked,
            fontItalic: document.getElementById('fontItalic').checked,
            // 艺术字效果
            strokeEnabled: document.getElementById('strokeEnabled').checked,
            strokeColor: document.getElementById('strokeColor').value,
            strokeWidth: parseInt(document.getElementById('strokeWidth').value),
            shadowEnabled: document.getElementById('shadowEnabled').checked,
            shadowColor: document.getElementById('shadowColor').value,
            shadowX: parseInt(document.getElementById('shadowX').value),
            shadowY: parseInt(document.getElementById('shadowY').value),
            shadowBlur: parseInt(document.getElementById('shadowBlur').value),
            glowEnabled: document.getElementById('glowEnabled').checked,
            glowColor: document.getElementById('glowColor').value,
            glowIntensity: parseInt(document.getElementById('glowIntensity').value),
            gradientEnabled: document.getElementById('gradientEnabled').checked,
            gradientColor1: document.getElementById('gradientColor1').value,
            gradientColor2: document.getElementById('gradientColor2').value,
            gradientDirection: document.getElementById('gradientDirection').value
        };
        
        localStorage.setItem('textStyle', JSON.stringify(style));
        
        // 显示保存成功提示
        const btn = document.getElementById('saveTextStyleBtn');
        const originalText = btn.textContent;
        btn.textContent = '已保存';
        btn.style.background = '#28a745';
        setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '';
        }, 1500);
    }
    

    
    getSavedTextStyle() {
        try {
            const saved = localStorage.getItem('textStyle');
            return saved ? JSON.parse(saved) : null;
        } catch (e) {
            return null;
        }
    }
    
    // 初始化时加载保存的文字样式
    loadSavedTextStyleOnInit() {
        const savedStyle = this.getSavedTextStyle();
        if (savedStyle) {
            // 应用到UI控件
            const fontFamily = document.getElementById('fontFamily');
            const fontSize = document.getElementById('fontSize');
            const textColor = document.getElementById('textColor');
            const textOpacity = document.getElementById('textOpacity');
            
            if (fontFamily && savedStyle.fontFamily) {
                fontFamily.value = savedStyle.fontFamily;
            }
            if (fontSize && savedStyle.fontSize) {
                fontSize.value = savedStyle.fontSize;
            }
            if (textColor && savedStyle.color) {
                textColor.value = savedStyle.color;
            }
            if (textOpacity && savedStyle.opacity !== undefined) {
                textOpacity.value = savedStyle.opacity;
                // 更新透明度显示值
                const opacityValue = document.getElementById('textOpacityValue');
                if (opacityValue) {
                    opacityValue.textContent = Math.round(savedStyle.opacity * 100) + '%';
                }
            }
        }
    }
    
    initializeArtTextControls() {
        // 描边效果控件
        const strokeEnabled = document.getElementById('strokeEnabled');
        const strokeControls = document.querySelector('.stroke-controls');
        strokeEnabled.addEventListener('change', (e) => {
            strokeControls.style.display = e.target.checked ? 'block' : 'none';
            this.updateSelectedTextArt();
        });
        
        document.getElementById('strokeColor').addEventListener('input', () => this.updateSelectedTextArt());
        document.getElementById('strokeWidth').addEventListener('input', (e) => {
            document.getElementById('strokeWidthValue').textContent = e.target.value + 'px';
            this.updateSelectedTextArt();
        });
        
        // 阴影效果控件
        const shadowEnabled = document.getElementById('shadowEnabled');
        const shadowControls = document.querySelector('.shadow-controls');
        shadowEnabled.addEventListener('change', (e) => {
            shadowControls.style.display = e.target.checked ? 'block' : 'none';
            this.updateSelectedTextArt();
        });
        
        document.getElementById('shadowColor').addEventListener('input', () => this.updateSelectedTextArt());
        document.getElementById('shadowX').addEventListener('input', (e) => {
            document.getElementById('shadowXValue').textContent = e.target.value;
            this.updateSelectedTextArt();
        });
        document.getElementById('shadowY').addEventListener('input', (e) => {
            document.getElementById('shadowYValue').textContent = e.target.value;
            this.updateSelectedTextArt();
        });
        document.getElementById('shadowBlur').addEventListener('input', (e) => {
            document.getElementById('shadowBlurValue').textContent = e.target.value;
            this.updateSelectedTextArt();
        });
        
        // 发光效果控件
        const glowEnabled = document.getElementById('glowEnabled');
        const glowControls = document.querySelector('.glow-controls');
        glowEnabled.addEventListener('change', (e) => {
            glowControls.style.display = e.target.checked ? 'block' : 'none';
            this.updateSelectedTextArt();
        });
        
        document.getElementById('glowColor').addEventListener('input', () => this.updateSelectedTextArt());
        document.getElementById('glowIntensity').addEventListener('input', (e) => {
            document.getElementById('glowIntensityValue').textContent = e.target.value + 'px';
            this.updateSelectedTextArt();
        });
        
        // 渐变效果控件
        const gradientEnabled = document.getElementById('gradientEnabled');
        const gradientControls = document.querySelector('.gradient-controls');
        gradientEnabled.addEventListener('change', (e) => {
            gradientControls.style.display = e.target.checked ? 'block' : 'none';
            this.updateSelectedTextArt();
        });
        
        document.getElementById('gradientColor1').addEventListener('input', () => this.updateSelectedTextArt());
        document.getElementById('gradientColor2').addEventListener('input', () => this.updateSelectedTextArt());
        document.getElementById('gradientDirection').addEventListener('change', () => this.updateSelectedTextArt());
    }
    
    updateSelectedTextArt() {
        if (!this.selectedTextElement) return;
        
        // 更新描边属性
        this.selectedTextElement.strokeEnabled = document.getElementById('strokeEnabled').checked;
        this.selectedTextElement.strokeColor = document.getElementById('strokeColor').value;
        this.selectedTextElement.strokeWidth = parseInt(document.getElementById('strokeWidth').value);
        
        // 更新阴影属性
        this.selectedTextElement.shadowEnabled = document.getElementById('shadowEnabled').checked;
        this.selectedTextElement.shadowColor = document.getElementById('shadowColor').value;
        this.selectedTextElement.shadowX = parseInt(document.getElementById('shadowX').value);
        this.selectedTextElement.shadowY = parseInt(document.getElementById('shadowY').value);
        this.selectedTextElement.shadowBlur = parseInt(document.getElementById('shadowBlur').value);
        
        // 更新发光属性
        this.selectedTextElement.glowEnabled = document.getElementById('glowEnabled').checked;
        this.selectedTextElement.glowColor = document.getElementById('glowColor').value;
        this.selectedTextElement.glowIntensity = parseInt(document.getElementById('glowIntensity').value);
        
        // 更新渐变属性
        this.selectedTextElement.gradientEnabled = document.getElementById('gradientEnabled').checked;
        this.selectedTextElement.gradientColor1 = document.getElementById('gradientColor1').value;
        this.selectedTextElement.gradientColor2 = document.getElementById('gradientColor2').value;
        this.selectedTextElement.gradientDirection = document.getElementById('gradientDirection').value;
        
        this.drawImage();
    }
    
    deleteSelectedText() {
        if (!this.selectedTextElement) return;
        
        const index = this.textElements.findIndex(el => el.id === this.selectedTextElement.id);
        if (index > -1) {
            this.textElements.splice(index, 1);
            this.selectedTextElement = null;
            this.hideTextControls();
            this.drawImage();
            this.saveState('删除文字');
        }
    }
    
    updateSelectedText() {
        if (!this.selectedTextElement) return;
        
        this.selectedTextElement.content = document.getElementById('textContent').value || '文字';
        this.selectedTextElement.fontFamily = document.getElementById('fontFamily').value;
        this.selectedTextElement.fontSize = parseInt(document.getElementById('fontSize').value);
        this.selectedTextElement.color = document.getElementById('textColor').value;
        this.selectedTextElement.opacity = document.getElementById('textOpacity').value / 100;
        
        // 更新字体样式
        this.selectedTextElement.fontBold = document.getElementById('fontBold').checked;
        this.selectedTextElement.fontItalic = document.getElementById('fontItalic').checked;
        
        // 更新艺术字属性
        this.updateSelectedTextArt();
        
        this.drawImage();
        this.saveUserSettings();
    }
    
    adjustFontSize(delta) {
        const fontSizeInput = document.getElementById('fontSize');
        let currentSize = parseInt(fontSizeInput.value);
        let newSize = currentSize + delta;
        
        // 限制字号范围
        newSize = Math.max(8, Math.min(200, newSize));
        
        fontSizeInput.value = newSize;
        
        // 如果有选中的文字，更新它
        if (this.selectedTextElement) {
            this.selectedTextElement.fontSize = newSize;
            this.drawImage();
        }
        
        // 保存设置
        this.saveUserSettings();
    }
    
    loadUserSettings() {
        try {
            const settings = localStorage.getItem('imageCropperSettings');
            if (settings) {
                const parsed = JSON.parse(settings);
                
                // 恢复字体设置
                if (parsed.fontFamily) {
                    const fontSelect = document.getElementById('fontFamily');
                    if (fontSelect) {
                        fontSelect.value = parsed.fontFamily;
                    }
                }
                
                if (parsed.fontSize) {
                    const fontSizeInput = document.getElementById('fontSize');
                    if (fontSizeInput) {
                        fontSizeInput.value = parsed.fontSize;
                    }
                }
                
                if (parsed.textColor) {
                    const colorInput = document.getElementById('textColor');
                    if (colorInput) {
                        colorInput.value = parsed.textColor;
                    }
                }
                
                if (parsed.textOpacity !== undefined) {
                    const opacityInput = document.getElementById('textOpacity');
                    if (opacityInput) {
                        opacityInput.value = parsed.textOpacity;
                    }
                }
                
                // 恢复导出格式设置
                if (parsed.exportFormat) {
                    const formatBtns = document.querySelectorAll('.format-btn');
                    formatBtns.forEach(btn => {
                        btn.classList.remove('active');
                        if (btn.dataset.format === parsed.exportFormat) {
                            btn.classList.add('active');
                        }
                    });
                }
                
                // 恢复质量设置
                if (parsed.quality !== undefined) {
                    const qualitySlider = document.getElementById('quality');
                    if (qualitySlider) {
                        qualitySlider.value = parsed.quality;
                        document.getElementById('qualityValue').textContent = parsed.quality;
                    }
                }
                
                // 恢复分辨率设置
                if (parsed.resolutionScale) {
                    const resolutionSelect = document.getElementById('resolutionScale');
                    if (resolutionSelect) {
                        resolutionSelect.value = parsed.resolutionScale;
                    }
                }
            }
            
            // 加载保存的文字样式
            this.loadSavedTextStyleOnInit();
        } catch (error) {
            console.log('Failed to load user settings:', error);
        }
    }
    
    saveUserSettings() {
        try {
            const settings = {
                fontFamily: document.getElementById('fontFamily')?.value,
                fontSize: document.getElementById('fontSize')?.value,
                textColor: document.getElementById('textColor')?.value,
                textOpacity: document.getElementById('textOpacity')?.value,
                exportFormat: document.querySelector('.format-btn.active')?.dataset.format,
                quality: document.getElementById('quality')?.value,
                resolutionScale: document.getElementById('resolutionScale')?.value
            };
            
            localStorage.setItem('imageCropperSettings', JSON.stringify(settings));
        } catch (error) {
            console.log('Failed to save user settings:', error);
        }
    }
    
    showTextControls() {
        document.getElementById('textControls').classList.add('active');
    }
    
    hideTextControls() {
        document.getElementById('textControls').classList.remove('active');
    }
    
    updateTextControls() {
        if (!this.selectedTextElement) return;
        
        document.getElementById('textContent').value = this.selectedTextElement.content;
        document.getElementById('fontFamily').value = this.selectedTextElement.fontFamily;
        document.getElementById('fontSize').value = this.selectedTextElement.fontSize;
        document.getElementById('textColor').value = this.selectedTextElement.color;
        document.getElementById('textOpacity').value = this.selectedTextElement.opacity * 100;
        
        // 更新字体样式控件状态
        document.getElementById('fontBold').checked = this.selectedTextElement.fontBold || false;
        document.getElementById('fontItalic').checked = this.selectedTextElement.fontItalic || false;
        
        // 更新艺术字控件状态
        this.updateArtTextControls();
    }
    
    updateArtTextControls() {
        if (!this.selectedTextElement) return;
        
        const textEl = this.selectedTextElement;
        
        // 更新描边控件
        document.getElementById('strokeEnabled').checked = textEl.strokeEnabled || false;
        document.querySelector('.stroke-controls').style.display = textEl.strokeEnabled ? 'block' : 'none';
        document.getElementById('strokeColor').value = textEl.strokeColor || '#ffffff';
        document.getElementById('strokeWidth').value = textEl.strokeWidth || 2;
        document.getElementById('strokeWidthValue').textContent = (textEl.strokeWidth || 2) + 'px';
        
        // 更新阴影控件
        document.getElementById('shadowEnabled').checked = textEl.shadowEnabled || false;
        document.querySelector('.shadow-controls').style.display = textEl.shadowEnabled ? 'block' : 'none';
        document.getElementById('shadowColor').value = textEl.shadowColor || '#000000';
        document.getElementById('shadowX').value = textEl.shadowX || 2;
        document.getElementById('shadowXValue').textContent = textEl.shadowX || 2;
        document.getElementById('shadowY').value = textEl.shadowY || 2;
        document.getElementById('shadowYValue').textContent = textEl.shadowY || 2;
        document.getElementById('shadowBlur').value = textEl.shadowBlur || 4;
        document.getElementById('shadowBlurValue').textContent = textEl.shadowBlur || 4;
        
        // 更新发光控件
        document.getElementById('glowEnabled').checked = textEl.glowEnabled || false;
        document.querySelector('.glow-controls').style.display = textEl.glowEnabled ? 'block' : 'none';
        document.getElementById('glowColor').value = textEl.glowColor || '#00ffff';
        document.getElementById('glowIntensity').value = textEl.glowIntensity || 10;
        document.getElementById('glowIntensityValue').textContent = (textEl.glowIntensity || 10) + 'px';
        
        // 更新渐变控件
        document.getElementById('gradientEnabled').checked = textEl.gradientEnabled || false;
        document.querySelector('.gradient-controls').style.display = textEl.gradientEnabled ? 'block' : 'none';
        document.getElementById('gradientColor1').value = textEl.gradientColor1 || '#ff0000';
        document.getElementById('gradientColor2').value = textEl.gradientColor2 || '#0000ff';
        document.getElementById('gradientDirection').value = textEl.gradientDirection || 'vertical';
    }
    
    handleCanvasMouseDown(e) {
        // 如果只有背景图没有主图，允许操作文字
        if (!this.currentImage && !this.backgroundImage) return;
        
        const rect = this.canvas.getBoundingClientRect();
        // 计算缩放比例并调整坐标
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        

        
        // 检查是否点击了文字元素
        for (let i = this.textElements.length - 1; i >= 0; i--) {
            const textEl = this.textElements[i];
            
            // 构建字体样式字符串（与绘制时保持一致）
            let fontStyle = '';
            if (textEl.fontItalic) fontStyle += 'italic ';
            if (textEl.fontBold) fontStyle += 'bold ';
            fontStyle += `${textEl.fontSize}px ${textEl.fontFamily}`;
            
            this.ctx.font = fontStyle;
            
            // 计算多行文字的边界（与drawTextElements中的逻辑完全一致）
            const lines = textEl.content.split('\n');
            const lineHeight = textEl.fontSize * 1.2; // 行高为字体大小的1.2倍
            
            // 计算文字边界框
            let maxWidth = 0;
            lines.forEach(line => {
                const textWidth = this.ctx.measureText(line).width;
                maxWidth = Math.max(maxWidth, textWidth);
            });
            
            const totalHeight = lines.length * lineHeight;
            const textX = textEl.x;
            const textY = textEl.y - textEl.fontSize; // 调整Y坐标到文字顶部
            

            
            // 检查点击是否在文字边界内（包含5px的边距，与绘制边框一致）
            if (x >= textX - 5 && x <= textX + maxWidth + 5 &&
                y >= textY - 5 && y <= textY + totalHeight + 5) {
                this.selectedTextElement = textEl;
                this.showTextControls();
                this.updateTextControls();
                this.isDragging = true;
                this.dragStart = { x: x - textEl.x, y: y - textEl.y };
                return;
            }
        }
        
        // 如果没有点击文字，清除文字选择
        this.selectedTextElement = null;
        this.hideTextControls();
        
        // 图片拖拽逻辑：
        // 1. 有背景图时：背景图被锁定不能拖拽，主图可以拖拽
        // 2. 没有背景图时：主图被锁定不能拖拽（作为背景图的角色）
        if (this.backgroundImage && this.currentImage) {
            // 有背景图且有主图时，只允许拖拽主图
            // 检查是否点击在主图区域内
            const imageRect = this.getMainImageRect();
            if (imageRect && x >= imageRect.left && x <= imageRect.right && 
                y >= imageRect.top && y <= imageRect.bottom) {
                this.isImageDragging = true;
                this.imageDragStart = { x: x, y: y };
            }
        } else {
            // 没有背景图时，主图作为背景图，不允许拖拽
            // 或者只有背景图没有主图时，背景图也不允许拖拽
            this.isImageDragging = false;
        }
    }
    
    handleCanvasMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        // 计算缩放比例并调整坐标
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        
        // 处理文字拖拽
        if (this.isDragging && this.selectedTextElement) {
            this.selectedTextElement.x = x - this.dragStart.x;
            this.selectedTextElement.y = y - this.dragStart.y;
            this.drawImage();
            return;
        }
        
        // 处理图片拖拽
        if (this.isImageDragging) {
            const deltaX = x - this.imageDragStart.x;
            const deltaY = y - this.imageDragStart.y;
            
            this.imageOffsetX += deltaX;
            this.imageOffsetY += deltaY;
            
            this.imageDragStart = { x: x, y: y };
            this.drawImage();
            return;
        }
        
        // 检查鼠标是否悬停在文字上，更新光标样式
        if (!this.isDragging && !this.isImageDragging) {
            const hoveredText = this.getTextElementAtPosition(x, y);
            if (hoveredText) {
                this.canvas.style.cursor = 'text';
                this.canvas.title = '拖拽移动文字，滚轮调整字号大小';
            } else if (this.backgroundImage && this.currentImage) {
                // 有背景图且有主图时，检查是否在主图区域
                const imageRect = this.getMainImageRect();
                if (imageRect && x >= imageRect.left && x <= imageRect.right && 
                    y >= imageRect.top && y <= imageRect.bottom) {
                    this.canvas.style.cursor = 'move';
                    this.canvas.title = '拖拽移动图片，滚轮缩放图片';
                } else {
                    this.canvas.style.cursor = 'default';
                    this.canvas.title = '';
                }
            } else {
                this.canvas.style.cursor = 'default';
                this.canvas.title = '';
            }
        }
    }
    
    handleCanvasMouseUp() {
        this.isDragging = false;
        this.isImageDragging = false;
    }
    
    handleCanvasWheel(e) {
        e.preventDefault();
        
        const rect = this.canvas.getBoundingClientRect();
        // 计算缩放比例并调整坐标
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        
        // 首先检查鼠标是否悬停在文字上，如果是则调整字体大小
        const hoveredText = this.getTextElementAtPosition(x, y);
        if (hoveredText) {
            // 调整字体大小
            const delta = e.deltaY > 0 ? -2 : 2; // 向下滚动减小字号，向上滚动增大字号
            const newSize = hoveredText.fontSize + delta;
            
            // 限制字号范围
            if (newSize >= 8 && newSize <= 200) {
                hoveredText.fontSize = newSize;
                
                // 更新文字控件显示（如果该文字被选中）
                if (this.selectedTextElement === hoveredText) {
                    document.getElementById('fontSize').value = newSize;
                }
                
                this.drawImage();
                this.saveState('调整字体大小');
            }
            return;
        }
        
        // 图片缩放逻辑：
        // 1. 有背景图时：背景图被锁定不能缩放，主图可以缩放
        // 2. 没有背景图时：主图被锁定不能缩放（作为背景图的角色）
        if (this.backgroundImage && this.currentImage) {
            // 有背景图且有主图时，允许缩放主图
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            const newScale = this.imageScale * delta;
            
            // 限制缩放范围
            if (newScale >= 0.1 && newScale <= 5) {
                this.imageScale = newScale;
                this.drawImage();
            }
        } else {
            // 没有背景图时，主图作为背景图，不允许缩放
            // 或者只有背景图没有主图时，背景图也不允许缩放
            return;
        }
    }
    
    handleCropMouseDown(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const target = e.target;
        if (target.classList.contains('crop-handle')) {
            this.isResizing = true;
            this.resizeHandle = target.classList[1]; // nw, ne, sw, se
        } else {
            this.isCropDragging = true;
        }
        
        this.dragStart = {
            x: e.clientX,
            y: e.clientY,
            overlayLeft: parseInt(document.getElementById('cropOverlay').style.left),
            overlayTop: parseInt(document.getElementById('cropOverlay').style.top),
            overlayWidth: parseInt(document.getElementById('cropOverlay').style.width),
            overlayHeight: parseInt(document.getElementById('cropOverlay').style.height)
        };
    }
    
    handleDocumentMouseMove(e) {
        if (this.isCropDragging) {
            this.handleCropDrag(e);
        } else if (this.isResizing) {
            this.handleCropResize(e);
        }
    }
    
    handleDocumentMouseUp() {
        this.isCropDragging = false;
        this.isResizing = false;
        this.resizeHandle = null;
    }
    
    handleCropDrag(e) {
        const deltaX = e.clientX - this.dragStart.x;
        const deltaY = e.clientY - this.dragStart.y;
        
        const overlay = document.getElementById('cropOverlay');
        const canvasRect = this.canvas.getBoundingClientRect();
        const canvasContainer = document.getElementById('canvasContainer');
        const containerRect = canvasContainer.getBoundingClientRect();
        
        // 计算画布在容器中的位置
        const canvasOffsetX = canvasRect.left - containerRect.left;
        const canvasOffsetY = canvasRect.top - containerRect.top;
        
        let newLeft = this.dragStart.overlayLeft + deltaX;
        let newTop = this.dragStart.overlayTop + deltaY;
        
        // 限制在画布范围内（考虑画布在容器中的偏移）
        const minLeft = canvasOffsetX;
        const maxLeft = canvasOffsetX + canvasRect.width - this.dragStart.overlayWidth;
        const minTop = canvasOffsetY;
        const maxTop = canvasOffsetY + canvasRect.height - this.dragStart.overlayHeight;
        
        newLeft = Math.max(minLeft, Math.min(newLeft, maxLeft));
        newTop = Math.max(minTop, Math.min(newTop, maxTop));
        
        overlay.style.left = newLeft + 'px';
        overlay.style.top = newTop + 'px';
        
        // 更新网格线位置（拖拽时网格线不需要重新创建，只需要保持相对位置）
        
        this.updateCropData();
    }
    
    handleCropResize(e) {
        const deltaX = e.clientX - this.dragStart.x;
        const deltaY = e.clientY - this.dragStart.y;
        
        const overlay = document.getElementById('cropOverlay');
        const canvasRect = this.canvas.getBoundingClientRect();
        
        let newLeft = this.dragStart.overlayLeft;
        let newTop = this.dragStart.overlayTop;
        let newWidth = this.dragStart.overlayWidth;
        let newHeight = this.dragStart.overlayHeight;
        
        // 计算基础变化
        switch (this.resizeHandle) {
            case 'nw':
                newLeft += deltaX;
                newTop += deltaY;
                newWidth -= deltaX;
                newHeight -= deltaY;
                break;
            case 'ne':
                newTop += deltaY;
                newWidth += deltaX;
                newHeight -= deltaY;
                break;
            case 'sw':
                newLeft += deltaX;
                newWidth -= deltaX;
                newHeight += deltaY;
                break;
            case 'se':
                newWidth += deltaX;
                newHeight += deltaY;
                break;
        }
        
        // 应用比例约束（除了自由裁剪模式）
        if (this.selectedRatio && this.selectedRatio !== 'free' && this.selectedRatio !== 'custom') {
            let aspectRatio;
            
            if (this.fixedWidth && this.fixedHeight) {
                aspectRatio = this.fixedWidth / this.fixedHeight;
            } else {
                const [w, h] = this.selectedRatio.split(':').map(Number);
                aspectRatio = w / h;
            }
            
            // 根据拖拽方向决定以哪个维度为准
            if (this.resizeHandle === 'se' || this.resizeHandle === 'nw') {
                // 对角线拖拽，以较大的变化为准
                if (Math.abs(deltaX) > Math.abs(deltaY)) {
                    newHeight = newWidth / aspectRatio;
                } else {
                    newWidth = newHeight * aspectRatio;
                }
            } else if (this.resizeHandle === 'ne' || this.resizeHandle === 'sw') {
                // 另一对角线，同样以较大变化为准
                if (Math.abs(deltaX) > Math.abs(deltaY)) {
                    newHeight = newWidth / aspectRatio;
                } else {
                    newWidth = newHeight * aspectRatio;
                }
            }
            
            // 重新计算位置以保持比例
            if (this.resizeHandle === 'nw') {
                newLeft = this.dragStart.overlayLeft + this.dragStart.overlayWidth - newWidth;
                newTop = this.dragStart.overlayTop + this.dragStart.overlayHeight - newHeight;
            } else if (this.resizeHandle === 'ne') {
                newTop = this.dragStart.overlayTop + this.dragStart.overlayHeight - newHeight;
            } else if (this.resizeHandle === 'sw') {
                newLeft = this.dragStart.overlayLeft + this.dragStart.overlayWidth - newWidth;
            }
        }
        
        // 限制最小尺寸
        newWidth = Math.max(50, newWidth);
        newHeight = Math.max(50, newHeight);
        
        // 计算画布在容器中的位置
        const canvasContainer = document.getElementById('canvasContainer');
        const containerRect = canvasContainer.getBoundingClientRect();
        const canvasOffsetX = canvasRect.left - containerRect.left;
        const canvasOffsetY = canvasRect.top - containerRect.top;
        
        // 允许裁剪区域扩展到整个画布区域
        // 限制最大尺寸为画布尺寸，但允许达到画布边界
        newWidth = Math.min(newWidth, canvasRect.width);
        newHeight = Math.min(newHeight, canvasRect.height);
        newLeft = Math.max(canvasOffsetX, Math.min(newLeft, canvasOffsetX + canvasRect.width - newWidth));
        newTop = Math.max(canvasOffsetY, Math.min(newTop, canvasOffsetY + canvasRect.height - newHeight));
        
        overlay.style.left = newLeft + 'px';
        overlay.style.top = newTop + 'px';
        overlay.style.width = newWidth + 'px';
        overlay.style.height = newHeight + 'px';
        
        // 更新网格线
        const existingGrid = overlay.querySelector('.grid-lines');
        if (existingGrid) {
            existingGrid.remove();
        }
        this.createGridLines(overlay, newWidth, newHeight);
        
        this.updateCropData();
    }
    
    updateCropData() {
        const overlay = document.getElementById('cropOverlay');
        const canvasRect = this.canvas.getBoundingClientRect();
        const canvasContainer = document.getElementById('canvasContainer');
        const containerRect = canvasContainer.getBoundingClientRect();
        
        const scaleX = this.canvas.width / canvasRect.width;
        const scaleY = this.canvas.height / canvasRect.height;
        
        // 计算画布在容器中的位置
        const canvasOffsetX = canvasRect.left - containerRect.left;
        const canvasOffsetY = canvasRect.top - containerRect.top;
        
        const overlayLeft = parseInt(overlay.style.left);
        const overlayTop = parseInt(overlay.style.top);
        const overlayWidth = parseInt(overlay.style.width);
        const overlayHeight = parseInt(overlay.style.height);
        
        // 计算相对于画布的坐标
        const relativeLeft = overlayLeft - canvasOffsetX;
        const relativeTop = overlayTop - canvasOffsetY;
        
        this.cropData = {
            x: relativeLeft * scaleX,
            y: relativeTop * scaleY,
            width: overlayWidth * scaleX,
            height: overlayHeight * scaleY
        };
        
        // 更新输入框
        document.getElementById('cropWidth').value = Math.round(this.cropData.width);
        document.getElementById('cropHeight').value = Math.round(this.cropData.height);
    }
    
    selectFormat(btn) {
        document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentFormat = btn.dataset.format;
        this.saveUserSettings();
    }
    
    downloadImage() {
        if (!this.currentImage) {
            alert('请先加载图片！');
            return;
        }
        
        // 获取分辨率缩放比例
        const resolutionScale = parseFloat(document.getElementById('resolutionScale').value) || 1;
        
        // 创建输出画布
        const outputCanvas = document.createElement('canvas');
        const outputCtx = outputCanvas.getContext('2d');
        
        // 检查是否有裁剪区域
        const cropOverlay = document.getElementById('cropOverlay');
        const hasCropArea = cropOverlay.classList.contains('active');
        
        if (hasCropArea && this.cropData) {
            // 有裁剪区域，只导出裁剪区域
            outputCanvas.width = this.cropData.width * resolutionScale;
            outputCanvas.height = this.cropData.height * resolutionScale;
            
            // 启用图像平滑
            outputCtx.imageSmoothingEnabled = true;
            outputCtx.imageSmoothingQuality = 'high';
            
            // 临时重新绘制画布，不显示虚线边框
            this.drawImage(false);
            
            // 只绘制裁剪区域
            outputCtx.drawImage(
                this.canvas,
                this.cropData.x, this.cropData.y, this.cropData.width, this.cropData.height,
                0, 0, outputCanvas.width, outputCanvas.height
            );
            
            // 恢复正常显示（带虚线边框）
            this.drawImage(true);
        } else if (this.currentImage) {
            // 没有裁剪区域但有主图，导出包含背景图的完整画布
            outputCanvas.width = this.canvas.width * resolutionScale;
            outputCanvas.height = this.canvas.height * resolutionScale;
            
            // 启用图像平滑
            outputCtx.imageSmoothingEnabled = true;
            outputCtx.imageSmoothingQuality = 'high';
            
            // 临时重新绘制画布，不显示虚线边框
            this.drawImage(false);
            
            // 将画布内容绘制到输出画布
            outputCtx.drawImage(this.canvas, 0, 0, outputCanvas.width, outputCanvas.height);
            
            // 恢复正常显示（带虚线边框）
            this.drawImage(true);
        } else {
            // 只有背景图，导出整个画布
            outputCanvas.width = this.canvas.width * resolutionScale;
            outputCanvas.height = this.canvas.height * resolutionScale;
            
            // 启用图像平滑
            outputCtx.imageSmoothingEnabled = true;
            outputCtx.imageSmoothingQuality = 'high';
            
            // 临时重新绘制画布，不显示虚线边框
            this.drawImage(false);
            
            // 将画布内容绘制到输出画布上
            outputCtx.drawImage(this.canvas, 0, 0, outputCanvas.width, outputCanvas.height);
            
            // 恢复正常显示（带虚线边框）
            this.drawImage(true);
        }
        
        let mimeType, extension;
        switch (this.currentFormat) {
            case 'jpg':
                mimeType = 'image/jpeg';
                extension = 'jpg';
                break;
            case 'webp':
                mimeType = 'image/webp';
                extension = 'webp';
                break;
            default:
                mimeType = 'image/png';
                extension = 'png';
        }
        
        const dataURL = outputCanvas.toDataURL(mimeType, this.quality);
        
        // 创建下载链接，避免生成临时文件
        const link = document.createElement('a');
        link.download = `edited_image_${Date.now()}_${resolutionScale}x.${extension}`;
        link.href = dataURL;
        
        // 添加到DOM并立即点击下载
        document.body.appendChild(link);
        link.click();
        
        // 清理：移除链接元素并释放blob URL
        document.body.removeChild(link);
        
        // 如果使用blob URL，需要释放内存
        if (dataURL.startsWith('blob:')) {
            URL.revokeObjectURL(dataURL);
        }
    }
    
    selectBackground() {
        const backgroundInput = document.getElementById('backgroundInput');
        backgroundInput.click();
    }
    
    handleBackgroundSelect(e) {
        const file = e.target.files[0];
        if (file) {
            this.loadBackgroundImage(file);
        }
        e.target.value = '';
    }
    
    loadBackgroundImage(file) {
        if (!this.isSupportedImage(file)) {
            alert('请选择有效的图片文件！');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.backgroundImage = img;

                if (this.currentImage) {
                    this.drawImage();
                } else {
                    // 如果没有主图片，限制画布尺寸以避免滚动条
                    const maxCanvasWidth = 680;
                    const maxCanvasHeight = 500; // 限制最大高度
                    
                    // 计算适合的尺寸，保持宽高比
                    const aspectRatio = img.width / img.height;
                    let canvasWidth = Math.min(img.width, maxCanvasWidth);
                    let canvasHeight = canvasWidth / aspectRatio;
                    
                    // 如果高度超过限制，重新计算
                    if (canvasHeight > maxCanvasHeight) {
                        canvasHeight = maxCanvasHeight;
                        canvasWidth = canvasHeight * aspectRatio;
                    }
                    
                    this.canvas.width = canvasWidth;
                    this.canvas.height = canvasHeight;
                    
                    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                    
                    // 绘制背景图，适配画布尺寸
                    this.ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
                    
                    this.showCanvas();
                }
                this.updateImageInfo();
                this.saveState('添加背景图片');
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }
    
    deleteImage() {
        // 重置到初始状态
        this.originalImage = null;
        this.currentImage = null;
        this.backgroundImage = null;
        this.rotation = 0;
        this.flipHorizontal = false;
        this.flipVertical = false;
        this.textElements = [];
        this.selectedTextElement = null;
        this.cropData = null;
        
        // 隐藏画布，显示上传区域
        this.hideCanvas();
        this.hideTextControls();
        this.hideCropOverlay();
        
        // 清除尺寸选择
        document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('cropWidth').value = '';
        document.getElementById('cropHeight').value = '';
        
        // 清除文件输入
        document.getElementById('fileInput').value = '';
        document.getElementById('backgroundInput').value = '';
        this.updateImageInfo();
        this.saveState('删除图片');
    }
    
    // 历史记录系统方法
    saveState(action = '操作') {
        // 创建当前状态的快照
        const state = {
            action: action,
            timestamp: Date.now(),
            originalImage: this.originalImage,
            currentImage: this.currentImage,
            backgroundImage: this.backgroundImage,
            rotation: this.rotation,
            flipHorizontal: this.flipHorizontal,
            flipVertical: this.flipVertical,
            textElements: JSON.parse(JSON.stringify(this.textElements)), // 深拷贝
            cropData: this.cropData ? { ...this.cropData } : null,
            imageScale: this.imageScale,
            imageOffsetX: this.imageOffsetX,
            imageOffsetY: this.imageOffsetY,
            canvasWidth: this.canvas.width,
            canvasHeight: this.canvas.height
        };
        
        // 如果当前不在历史记录的末尾，删除后面的记录
        if (this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }
        
        // 添加新状态
        this.history.push(state);
        this.historyIndex++;
        
        // 限制历史记录大小
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
            this.historyIndex--;
        }
        
        this.updateHistoryButtons();
    }
    
    undo() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.restoreState(this.history[this.historyIndex]);
            this.updateHistoryButtons();
        }
    }
    
    redo() {
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.restoreState(this.history[this.historyIndex]);
            this.updateHistoryButtons();
        }
    }
    
    restoreState(state) {
        // 恢复所有状态
        this.originalImage = state.originalImage;
        this.currentImage = state.currentImage;
        this.backgroundImage = state.backgroundImage;
        this.rotation = state.rotation;
        this.flipHorizontal = !!state.flipHorizontal;
        this.flipVertical = !!state.flipVertical;
        this.textElements = JSON.parse(JSON.stringify(state.textElements)); // 深拷贝
        this.cropData = state.cropData ? { ...state.cropData } : null;
        this.imageScale = state.imageScale;
        this.imageOffsetX = state.imageOffsetX;
        this.imageOffsetY = state.imageOffsetY;
        
        // 恢复画布尺寸
        this.canvas.width = state.canvasWidth;
        this.canvas.height = state.canvasHeight;
        
        // 重新绘制
        if (this.currentImage || this.backgroundImage) {
            this.showCanvas();
            this.drawImage();
        } else {
            this.hideCanvas();
        }
        this.updateImageInfo();
        
        // 清除选中的文字元素
        this.selectedTextElement = null;
        this.hideTextControls();
    }
    
    updateHistoryButtons() {
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        
        if (undoBtn) {
            undoBtn.disabled = this.historyIndex <= 0;
            undoBtn.title = this.historyIndex > 0 ? `撤销: ${this.history[this.historyIndex].action}` : '无法撤销';
        }
        
        if (redoBtn) {
            redoBtn.disabled = this.historyIndex >= this.history.length - 1;
            redoBtn.title = this.historyIndex < this.history.length - 1 ? `重做: ${this.history[this.historyIndex + 1].action}` : '无法重做';
        }
    }

}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    new ImageEditor();
});
