window.DrawingBoard = typeof DrawingBoard !== "undefined" ? DrawingBoard : {};

/**
 * pass the id of the html element to put the drawing board into
 * and some options : {
 *	controls: array of controls to initialize with the drawingboard. 'Colors', 'Size', and 'Navigation' by default
 *		instead of simple strings, you can pass an object to define a control opts
 *		ie ['Color', { Navigation: { reset: false }}]
 *	controlsPosition: "top left" by default. Define where to put the controls: at the "top" or "bottom" of the canvas, aligned to "left"/"right"/"center"
 *	background: background of the drawing board. Give a hex color or an image url "#ffffff" (white) by default
 *	color: pencil color ("#000000" by default)
 *	size: pencil size (3 by default)
 *	webStorage: 'session', 'local' or false ('session' by default). store the current drawing in session or local storage and restore it when you come back
 *	droppable: true or false (false by default). If true, dropping an image on the canvas will include it and allow you to draw on it,
 *	errorMessage: html string to put in the board's element on browsers that don't support canvas.
 *	stretchImg: default behavior of image setting on the canvas: set to the canvas width/height or not? false by default
 * }
 */
DrawingBoard.Board = function(id, opts) {
	this.opts = this.mergeOptions(opts);

	this.ev = new DrawingBoard.Utils.MicroEvent();

	this.id = id;
	this.$el = $(document.getElementById(id));
	if (!this.$el.length)
		return false;

	var tpl = '<div class="drawing-board-canvas-wrapper"></canvas><canvas class="drawing-board-canvas"></canvas><div class="drawing-board-cursor drawing-board-utils-hidden"></div></div>';
	if (this.opts.controlsPosition.indexOf("bottom") > -1) tpl += '<div class="drawing-board-controls"></div>';
	else tpl = '<div class="drawing-board-controls"></div>' + tpl;

	this.$el.addClass('drawing-board').append(tpl);
	this.dom = {
		$canvasWrapper: this.$el.find('.drawing-board-canvas-wrapper'),
		$canvas: this.$el.find('.drawing-board-canvas'),
		$cursor: this.$el.find('.drawing-board-cursor'),
		$controls: this.$el.find('.drawing-board-controls')
	};

	$.each(['left', 'right', 'center'], $.proxy(function(n, val) {
		if (this.opts.controlsPosition.indexOf(val) > -1) {
			this.dom.$controls.attr('data-align', val);
			return false;
		}
	}, this));

	this.canvas = this.dom.$canvas.get(0);
	this.ctx = this.canvas && this.canvas.getContext && this.canvas.getContext('2d') ? this.canvas.getContext('2d') : null;
	this.color = this.opts.color;

	if (!this.ctx) {
		if (this.opts.errorMessage)
			this.$el.html(this.opts.errorMessage);
		return false;
	}

	this.storage = this._getStorage();

	this.initHistory();
	//init default board values before controls are added (mostly pencil color and size)
	this.reset({ webStorage: false, history: false, background: false });
	//init controls (they will need the default board values to work like pencil color and size)
	this.initControls();
	//set board's size after the controls div is added
	this.resize();
	//reset the board to take all resized space
	this.reset({ webStorage: false, history: true, background: true });
	this.restoreWebStorage();
	this.initDropEvents();
	this.initDrawEvents();
};



DrawingBoard.Board.defaultOpts = {
	controls: ['Color', 'DrawingMode', 'Size', 'Navigation'],
	controlsPosition: "top left",
	color: "#000000",
	size: 1,
	background: "#fff",
	eraserColor: "background",
	fillTolerance: 100,
	fillHack: true, //try to prevent issues with anti-aliasing with a little hack by default
	webStorage: 'session',
	droppable: false,
	enlargeYourContainer: false,
	errorMessage: "<p>It seems you use an obsolete browser. <a href=\"http://browsehappy.com/\" target=\"_blank\">Update it</a> to start drawing.</p>",
	stretchImg: false //when setting the canvas img, strech the image at the whole canvas size when this opt is true
};



DrawingBoard.Board.prototype = {

	mergeOptions: function(opts) {
		opts = $.extend({}, DrawingBoard.Board.defaultOpts, opts);
		if (!opts.background && opts.eraserColor === "background")
			opts.eraserColor = "transparent";
		return opts;
	},

	/**
	 * Canvas reset/resize methods: put back the canvas to its default values
	 *
	 * depending on options, can set color, size, background back to default values
	 * and store the reseted canvas in webstorage and history queue
	 *
	 * resize values depend on the `enlargeYourContainer` option
	 */

	reset: function(opts) {
		opts = $.extend({
			color: this.opts.color,
			size: this.opts.size,
			webStorage: true,
			history: true,
			background: false
		}, opts);

		this.setMode('pencil');

		if (opts.background) this.resetBackground(this.opts.background, false);

		if (opts.color) this.setColor(opts.color);
		if (opts.size) this.ctx.lineWidth = opts.size;

		this.ctx.lineCap = "round";
		this.ctx.lineJoin = "round";
		// this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.width);

		if (opts.webStorage) this.saveWebStorage();

		if (opts.history) this.saveHistory();

		this.blankCanvas = this.getImg();
		
		this.ev.trigger('board:reset', opts);
		updateTinyBoard();
	},

	resetBackground: function(background, historize) {
		background = background || this.opts.background;
		historize = typeof historize !== "undefined" ? historize : true;
		var bgIsColor = DrawingBoard.Utils.isColor(background);
		var prevMode = this.getMode();
		this.setMode('pencil');
		this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
		if (bgIsColor) {
			this.ctx.fillStyle = background;
			this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
		} else if (background)
			this.setImg(background);		
		this.setMode(prevMode);
		if (historize) this.saveHistory();
	},

	resize: function() {
		this.dom.$controls.toggleClass('drawing-board-controls-hidden', (!this.controls || !this.controls.length));

		var canvasWidth, canvasHeight;
		var widths = [
			this.$el.width(),
			DrawingBoard.Utils.boxBorderWidth(this.$el),
			DrawingBoard.Utils.boxBorderWidth(this.dom.$canvasWrapper, true, true)
		];
		var heights = [
			this.$el.height(),
			DrawingBoard.Utils.boxBorderHeight(this.$el),
			this.dom.$controls.height(),
			DrawingBoard.Utils.boxBorderHeight(this.dom.$controls, false, true),
			DrawingBoard.Utils.boxBorderHeight(this.dom.$canvasWrapper, true, true)
		];
		var that = this;
		var sum = function(values, multiplier) { //make the sum of all array values
			multiplier = multiplier || 1;
			var res = values[0];
			for (var i = 1; i < values.length; i++) {
				res = res + (values[i]*multiplier);
			}
			return res;
		};
		var sub = function(values) { return sum(values, -1); }; //substract all array values from the first one

		if (this.opts.enlargeYourContainer) {
			canvasWidth = this.$el.width();
			canvasHeight = this.$el.height();

			this.$el.width( sum(widths) );
			this.$el.height( sum(heights) );
		} else {
			canvasWidth = sub(widths);
			canvasHeight = sub(heights);
		}

		this.dom.$canvasWrapper.css('width', canvasWidth + 'px');
		this.dom.$canvasWrapper.css('height', canvasHeight + 'px');

		this.dom.$canvas.css('width', canvasWidth + 'px');
		this.dom.$canvas.css('height', canvasHeight + 'px');

		this.canvas.width = canvasWidth;
		this.canvas.height = canvasHeight;
	},



	/**
	 * Controls:
	 * the drawing board can has various UI elements to control it.
	 * one control is represented by a class in the namespace DrawingBoard.Control
	 * it must have a $el property (jQuery object), representing the html element to append on the drawing board at initialization.
	 *
	 */

	initControls: function() {
		this.controls = [];
		if (!this.opts.controls.length || !DrawingBoard.Control) return false;
		for (var i = 0; i < this.opts.controls.length; i++) {
			var c = null;
			if (typeof this.opts.controls[i] == "string")
				c = new window['DrawingBoard']['Control'][this.opts.controls[i]](this);
			else if (typeof this.opts.controls[i] == "object") {
				for (var controlName in this.opts.controls[i]) break;
				c = new window['DrawingBoard']['Control'][controlName](this, this.opts.controls[i][controlName]);
			}
			if (c) {
				this.addControl(c);
			}
		}
	},

	//add a new control or an existing one at the position you want in the UI
	//to add a totally new control, you can pass a string with the js class as 1st parameter and control options as 2nd ie "addControl('Navigation', { reset: false }"
	//the last parameter (2nd or 3rd depending on the situation) is always the position you want to place the control at
	addControl: function(control, optsOrPos, pos) {
		if (typeof control !== "string" && (typeof control !== "object" || !control instanceof DrawingBoard.Control))
			return false;

		var opts = typeof optsOrPos == "object" ? optsOrPos : {};
		pos = pos ? pos*1 : (typeof optsOrPos == "number" ? optsOrPos : null);

		if (typeof control == "string")
			control = new window['DrawingBoard']['Control'][control](this, opts);

		if (pos)
			this.dom.$controls.children().eq(pos).before(control.$el);
		else
			this.dom.$controls.append(control.$el);

		if (!this.controls)
			this.controls = [];
		this.controls.push(control);
		this.dom.$controls.removeClass('drawing-board-controls-hidden');
	},



	/**
	 * History methods: undo and redo drawed lines
	 */

	initHistory: function() {
		this.history = {
			values: [],
			position: 0
		};
	},

	saveHistory: function () {
		while (this.history.values.length > 30) {
			this.history.values.shift();
			this.history.position--;
		}
		if (this.history.position !== 0 && this.history.position < this.history.values.length) {
			this.history.values = this.history.values.slice(0, this.history.position);
			this.history.position++;
		} else {
			this.history.position = this.history.values.length+1;
		}
		this.history.values.push(this.getImg());
		this.ev.trigger('historyNavigation', this.history.position);
	},

	_goThroughHistory: function(goForth) {
		if ((goForth && this.history.position == this.history.values.length) ||
			(!goForth && this.history.position == 1))
			return;
		var pos = goForth ? this.history.position+1 : this.history.position-1;
		if (this.history.values.length && this.history.values[pos-1] !== undefined) {
			this.history.position = pos;
			this.setImg(this.history.values[pos-1]);
		}
		this.ev.trigger('historyNavigation', pos);
		this.saveWebStorage();
	},

	goBackInHistory: function() {
		this._goThroughHistory(false);
	},

	goForthInHistory: function() {
		this._goThroughHistory(true);
	},



	/**
	 * Image methods: you can directly put an image on the canvas, get it in base64 data url or start a download
	 */

	setImg: function(src, opts) {
		opts = $.extend({
			stretch: this.opts.stretchImg
		}, opts);
		var ctx = this.ctx;
		var img = new Image();
		var oldGCO = ctx.globalCompositeOperation;
		img.onload = function() {
			ctx.globalCompositeOperation = "source-over";
			ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

			if (opts.stretch) {
				ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
			} else {
				ctx.drawImage(img, 0, 0);
			}

			ctx.globalCompositeOperation = oldGCO;
		};
//		img.src = src;
//        img.src = 'images/spectrum.png'
//        img.src = 'https://raw.githubusercontent.com/DBertazioli/CNN_VIZ/master/images/spectrum.png'
        img.src = "data:image/png;base64,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"
	},

	getImg: function() {
//		return this.canvas.toDataURL("image/png");
//        return this.setImg("ops")
//        return url()
		return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
	},

	downloadImg: function() {
		var img = this.getImg();
		updateTinyBoard();
		//img = img.replace("image/png", "image/octet-stream");
		//window.location.href = img;
	},



	/**
	 * WebStorage handling : save and restore to local or session storage
	 */

	saveWebStorage: function() {
		if (window[this.storage]) {
			window[this.storage].setItem('drawing-board-' + this.id, this.getImg());
			this.ev.trigger('board:save' + this.storage.charAt(0).toUpperCase() + this.storage.slice(1), this.getImg());
		}
	},

	restoreWebStorage: function() {
		if (window[this.storage] && window[this.storage].getItem('drawing-board-' + this.id) !== null) {
			this.setImg(window[this.storage].getItem('drawing-board-' + this.id));
			this.ev.trigger('board:restore' + this.storage.charAt(0).toUpperCase() + this.storage.slice(1), window[this.storage].getItem('drawing-board-' + this.id));
		}
	},

	clearWebStorage: function() {
		if (window[this.storage] && window[this.storage].getItem('drawing-board-' + this.id) !== null) {
			window[this.storage].removeItem('drawing-board-' + this.id);
			this.ev.trigger('board:clear' + this.storage.charAt(0).toUpperCase() + this.storage.slice(1));
		}
	},

	_getStorage: function() {
		if (!this.opts.webStorage || !(this.opts.webStorage === 'session' || this.opts.webStorage === 'local')) return false;
		return this.opts.webStorage + 'Storage';
	},



	/**
	 * Drop an image on the canvas to draw on it
	 */

	initDropEvents: function() {
		if (!this.opts.droppable)
			return false;

		this.dom.$canvas.on('dragover dragenter drop', function(e) {
			e.stopPropagation();
			e.preventDefault();
		});

		this.dom.$canvas.on('drop', $.proxy(this._onCanvasDrop, this));
	},

	_onCanvasDrop: function(e) {
		e = e.originalEvent ? e.originalEvent : e;
		var files = e.dataTransfer.files;
		if (!files || !files.length || files[0].type.indexOf('image') == -1 || !window.FileReader)
			return false;
		var fr = new FileReader();
		fr.readAsDataURL(files[0]);
		fr.onload = $.proxy(function(ev) {
			this.setImg(ev.target.result);
			this.ev.trigger('board:imageDropped', ev.target.result);
			this.ev.trigger('board:userAction');
			this.saveHistory();
		}, this);
	},



	/**
	 * set and get current drawing mode
	 *
	 * possible modes are "pencil" (draw normally), "eraser" (draw transparent, like, erase, you know), "filler" (paint can)
	 */

	setMode: function(newMode, silent) {
		silent = silent || false;
		newMode = newMode || 'pencil';

		this.ev.unbind('board:startDrawing', $.proxy(this.fill, this));

		if (this.opts.eraserColor === "transparent")
			this.ctx.globalCompositeOperation = newMode === "eraser" ? "destination-out" : "source-over";
		else {
			if (newMode === "eraser") {
				if (this.opts.eraserColor === "background" && DrawingBoard.Utils.isColor(this.opts.background))
					this.ctx.strokeStyle = this.opts.background;
				else if (DrawingBoard.Utils.isColor(this.opts.eraserColor))
					this.ctx.strokeStyle = this.opts.eraserColor;
			} else if (!this.mode || this.mode === "eraser") {
				this.ctx.strokeStyle = this.color;
			}

			if (newMode === "filler")
				this.ev.bind('board:startDrawing', $.proxy(this.fill, this));
		}
		this.mode = newMode;
		if (!silent)
			this.ev.trigger('board:mode', this.mode);
	},

	getMode: function() {
		return this.mode || "pencil";
	},

	setColor: function(color) {
		var that = this;
		color = color || this.color;
		if (!DrawingBoard.Utils.isColor(color))
			return false;
		this.color = color;
		if (this.opts.eraserColor !== "transparent" && this.mode === "eraser") {
			var setStrokeStyle = function(mode) {
				if (mode !== "eraser")
					that.strokeStyle = that.color;
				that.ev.unbind('board:mode', setStrokeStyle);
			};
			this.ev.bind('board:mode', setStrokeStyle);
		} else
			this.ctx.strokeStyle = this.color;
	},

	/**
	 * Fills an area with the current stroke color.
	 */
	fill: function(e) {
		if (this.getImg() === this.blankCanvas) {
			this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.width);
			this.ctx.fillStyle = this.color;
			this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
			return;
		}

		var img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

		// constants identifying pixels components
		var INDEX = 0, X = 1, Y = 2, COLOR = 3;

		// target color components
		var stroke = this.ctx.strokeStyle;
		var r = parseInt(stroke.substr(1, 2), 16);
		var g = parseInt(stroke.substr(3, 2), 16);
		var b = parseInt(stroke.substr(5, 2), 16);

		// starting point
		var start = DrawingBoard.Utils.pixelAt(img, parseInt(e.coords.x, 10), parseInt(e.coords.y, 10));
		var startColor = start[COLOR];
		var tolerance = this.opts.fillTolerance;
		var useHack = this.opts.fillHack; //see https://github.com/Leimi/drawingboard.js/pull/38

		// no need to continue if starting and target colors are the same
		if (DrawingBoard.Utils.compareColors(startColor, DrawingBoard.Utils.RGBToInt(r, g, b), tolerance))
			return;

		// pixels to evaluate
		var queue = [start];

		// loop vars
		var pixel, x, y;
		var maxX = img.width - 1;
		var maxY = img.height - 1;

		function updatePixelColor(pixel) {
			img.data[pixel[INDEX]] = r;
			img.data[pixel[INDEX] + 1] = g;
			img.data[pixel[INDEX] + 2] = b;
		}

		while ((pixel = queue.pop())) {
			if (useHack)
				updatePixelColor(pixel);

			if (DrawingBoard.Utils.compareColors(pixel[COLOR], startColor, tolerance)) {
				if (!useHack)
					updatePixelColor(pixel);
				if (pixel[X] > 0) // west
					queue.push(DrawingBoard.Utils.pixelAt(img, pixel[X] - 1, pixel[Y]));
				if (pixel[X] < maxX) // east
					queue.push(DrawingBoard.Utils.pixelAt(img, pixel[X] + 1, pixel[Y]));
				if (pixel[Y] > 0) // north
					queue.push(DrawingBoard.Utils.pixelAt(img, pixel[X], pixel[Y] - 1));
				if (pixel[Y] < maxY) // south
					queue.push(DrawingBoard.Utils.pixelAt(img, pixel[X], pixel[Y] + 1));
			}
		}

		this.ctx.putImageData(img, 0, 0);
	},


	/**
	 * Drawing handling, with mouse or touch
	 */

	initDrawEvents: function() {
		this.isDrawing = false;
		this.isMouseHovering = false;
		this.coords = {};
		this.coords.old = this.coords.current = this.coords.oldMid = { x: 0, y: 0 };

		this.dom.$canvas.on('mousedown touchstart', $.proxy(function(e) {
			this._onInputStart(e, this._getInputCoords(e) );
		}, this));

		this.dom.$canvas.on('mousemove touchmove', $.proxy(function(e) {
			this._onInputMove(e, this._getInputCoords(e) );
		}, this));

		this.dom.$canvas.on('mousemove', $.proxy(function(e) {

		}, this));

		this.dom.$canvas.on('mouseup touchend', $.proxy(function(e) {
			this._onInputStop(e, this._getInputCoords(e) );
		}, this));

		this.dom.$canvas.on('mouseover', $.proxy(function(e) {
			this._onMouseOver(e, this._getInputCoords(e) );
		}, this));

		this.dom.$canvas.on('mouseout', $.proxy(function(e) {
			this._onMouseOut(e, this._getInputCoords(e) );

		}, this));

		$('body').on('mouseup touchend', $.proxy(function(e) {
			this.isDrawing = false;
		}, this));

		if (window.requestAnimationFrame) requestAnimationFrame( $.proxy(this.draw, this) );
	},

	draw: function() {
		//if the pencil size is big (>10), the small crosshair makes a friend: a circle of the size of the pencil
		//todo: have the circle works on every browser - it currently should be added only when CSS pointer-events are supported
		//we assume that if requestAnimationFrame is supported, pointer-events is too, but this is terribad.
		if (window.requestAnimationFrame && this.ctx.lineWidth > 10 && this.isMouseHovering) {
			this.dom.$cursor.css({ width: this.ctx.lineWidth + 'px', height: this.ctx.lineWidth + 'px' });
			var transform = DrawingBoard.Utils.tpl("translateX({{x}}px) translateY({{y}}px)", { x: this.coords.current.x-(this.ctx.lineWidth/2), y: this.coords.current.y-(this.ctx.lineWidth/2) });
			this.dom.$cursor.css({ 'transform': transform, '-webkit-transform': transform, '-ms-transform': transform });
			this.dom.$cursor.removeClass('drawing-board-utils-hidden');
		} else {
			this.dom.$cursor.addClass('drawing-board-utils-hidden');
		}

		if (this.isDrawing) {
			var currentMid = this._getMidInputCoords(this.coords.current);
			this.ctx.beginPath();
			this.ctx.moveTo(currentMid.x, currentMid.y);
			this.ctx.quadraticCurveTo(this.coords.old.x, this.coords.old.y, this.coords.oldMid.x, this.coords.oldMid.y);
			this.ctx.stroke();

			this.coords.old = this.coords.current;
			this.coords.oldMid = currentMid;
		}

		if (window.requestAnimationFrame) requestAnimationFrame( $.proxy(function() { this.draw(); }, this) );
	},

	_onInputStart: function(e, coords) {
		this.coords.current = this.coords.old = coords;
		this.coords.oldMid = this._getMidInputCoords(coords);
		this.isDrawing = true;

		if (!window.requestAnimationFrame) this.draw();

		this.ev.trigger('board:startDrawing', {e: e, coords: coords});
		e.stopPropagation();
		e.preventDefault();
		goodStart = true;
	},

	_onInputMove: function(e, coords) {
		this.coords.current = coords;
		this.ev.trigger('board:drawing', {e: e, coords: coords});

		if (!window.requestAnimationFrame) this.draw();

		e.stopPropagation();
		e.preventDefault();
	},

	_onInputStop: function(e, coords) {
		if (this.isDrawing && (!e.touches || e.touches.length === 0)) {
			this.isDrawing = false;

			this.saveWebStorage();
			this.saveHistory();

			this.ev.trigger('board:stopDrawing', {e: e, coords: coords});
			this.ev.trigger('board:userAction');
			e.stopPropagation();
			e.preventDefault();
		}
		updateTinyBoard();
	},

	_onMouseOver: function(e, coords) {
		this.isMouseHovering = true;
		this.coords.old = this._getInputCoords(e);
		this.coords.oldMid = this._getMidInputCoords(this.coords.old);

		this.ev.trigger('board:mouseOver', {e: e, coords: coords});
	},

	_onMouseOut: function(e, coords) {
		this.isMouseHovering = false;

		this.ev.trigger('board:mouseOut', {e: e, coords: coords});
		updateTinyBoard();
	},

	_getInputCoords: function(e) {
		e = e.originalEvent ? e.originalEvent : e;
		var x, y;
		if (e.touches && e.touches.length == 1) {
			x = e.touches[0].pageX;
			y = e.touches[0].pageY;
		} else {
			x = e.pageX;
			y = e.pageY;
		}
		return {
			x: x - this.dom.$canvas.offset().left,
			y: y - this.dom.$canvas.offset().top
		};
	},

	_getMidInputCoords: function(coords) {
		return {
			x: this.coords.old.x + coords.x>>1,
			y: this.coords.old.y + coords.y>>1
		};
	}
};
