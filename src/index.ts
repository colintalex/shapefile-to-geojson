import { promises as fs } from "fs";
import { Feature } from "geojson";
import * as path from "path";
import { readFileSync } from 'fs';
var prj2epsg = require("prj2epsg");
var epsg = require("epsg");
var reproject = require("reproject");
// TODO: fix this to be more specific
type GeoJSON = any;

interface Configuration {
	/**
	 * If property values should be trimmed.
	 * @default true
	 */
	"trim"?: boolean;
}

/**
 * Parses a folder path containing a `shp` & `dbf` file pair into a GeoJSON object.
 * @param folder The path to the folder containing the `shp` & `dbf` file.
 * @param configuration The configuration settings to use.
 * @returns A promise containing the GeoJSON object.
 */
export const parseFolder = async (folder: string, configuration?: Configuration): Promise<GeoJSON> => {
	const files = await fs.readdir(folder);
	const shpFiles = files.filter((file) => file.endsWith(".shp"));
	const dbfFiles = files.filter((file) => file.endsWith(".dbf"));
	const prjFiles = files.filter((file) => file.endsWith(".prj"));

	if (shpFiles.length > 1) {
		throw new Error("Multiple shapefiles found.");
	}
	if (dbfFiles.length > 1) {
		throw new Error("Multiple dbf files found.");
	}
	if (prjFiles.length > 1) {
		throw new Error("Multiple prj files found.");
	}
	if (shpFiles.length === 0) {
		throw new Error("No shapefiles found.");
	}
	if (dbfFiles.length === 0) {
		throw new Error("No dbf files found.");
	}
	if (prjFiles.length === 0) {
		throw new Error("No prj files found.");
	}

	return parseFiles(path.join(folder, shpFiles[0]), path.join(folder, dbfFiles[0]), path.join(folder, prjFiles[0]), configuration);
};

class Parser {
	#shp: Buffer;
	#dbf: Buffer;
	#prj: Buffer;
	#configuration?: Configuration;
	#features: any[] = [];
	#propertiesArray: any[] = [];

	constructor(shp: Buffer, dbf: Buffer, prj: Buffer, configuration?: Configuration) {
		this.#shp = shp;
		this.#dbf = dbf;
		this.#prj = prj;
		this.#configuration = configuration;
	}

	#parseShp() {
		const dataView = new DataView(new Uint8Array(this.#shp).buffer);
		let idx = 0;
		const fileCode = dataView.getInt32(idx, false);
		const wordLength = dataView.getInt32(idx += 6 * 4, false);
		const byteLength = wordLength * 2;
		const version = dataView.getInt32(idx += 4, true);
		const shapeType = dataView.getInt32(idx += 4, true);
		const minX = dataView.getFloat64(idx += 4, true);
		const minY = dataView.getFloat64(idx + 8, true);
		const maxX = dataView.getFloat64(idx + 16, true);
		const maxY = dataView.getFloat64(idx + 24, true);
		const minZ = dataView.getFloat64(idx + 32, true);
		const maxZ = dataView.getFloat64(idx + 40, true);
		const minM = dataView.getFloat64(idx + 48, true);
		const maxM = dataView.getFloat64(idx + 56, true);
		idx += 8 * 8;

		const features: any[] = [];
		while (idx < byteLength) {
			const feature: any = {};
			const number: number = dataView.getInt32(idx, false);
			const length: number = dataView.getInt32(idx += 4, false);
			try {
				const type: number = dataView.getInt32(idx += 4, true);
				let idxFeature: number = idx + 4;
				const byteLen: number = length * 2;
				switch (type) {
					case 1:
					case 11:
					case 21:
						feature.type = "Point";
						feature.coordinates = [
							dataView.getFloat64(idxFeature, true),
							dataView.getFloat64(idxFeature + 8, true)
						];
						break;
					case 3:
					case 13:
					case 23:
					case 5:
					case 15:
					case 25:
						if (type === 3 || type === 13 || type === 23) {
							feature.type = "MultiLineString";
						} else if (type === 5 || type === 15 || type === 25) {
							feature.type = "Polygon";
						}
						const numberOfParts: number = dataView.getInt32(idxFeature + 32, true);
						const nbpoints: number = dataView.getInt32(idxFeature + 36, true);
						idxFeature += 40;
						const nbpartsPoint: number[] = new Array(numberOfParts).fill(0).map(() => {
							const result = dataView.getInt32(idxFeature, true);
							idxFeature += 4;
							return result;
						});

						feature.coordinates = new Array(numberOfParts).fill(0).map((_, i) => {
							const idstart = nbpartsPoint[i];
							const idend = (i < numberOfParts - 1 ? nbpartsPoint[i + 1] : nbpoints) - 1;
							const part = [];
							for (let j = idstart; j <= idend; j++) {
								part.push([
									dataView.getFloat64(idxFeature, true),
									dataView.getFloat64(idxFeature + 8, true)
								]);
								idxFeature += 16;
							}
							return part;
						});
						break;
					case 8:
					case 18:
					case 28:
						feature.type = "MultiPoint";
						const numberOfPoints = dataView.getInt32(idxFeature + 32, true);
						idxFeature += 36;
						feature.coordinates = new Array(numberOfPoints).fill(0).map(() => {
							const result = [
								dataView.getFloat64(idxFeature, true),
								dataView.getFloat64(idxFeature + 8, true)
							];
							idxFeature += 16;
							return result;
						});
						break;
				}
			} catch (e) { }
			idx += length * 2;
			features.push(feature);
		}
		this.#features = features;
	}

	#parseDbf() {
		const dataView = new DataView(new Uint8Array(this.#dbf).buffer);
		let idx = 4;
		const numberOfRecords: number = dataView.getInt32(idx, true);
		idx += 28;
		let end: boolean = false;
		const fields = [];
		try {
			while (true) {
				let field: any = {};
				let nameArray: string[] = [];
				for (let i = 0; i < 10; i++) {
					let letter = dataView.getUint8(idx);
					if (letter != 0) {
						nameArray.push(String.fromCharCode(letter));
					}
					idx += 1;
				}
				field.name = nameArray.join("");
				idx += 1;
				field.type = String.fromCharCode(dataView.getUint8(idx));
				idx += 5;
				field.fieldLength = dataView.getUint8(idx);
				idx += 16;
				fields.push(field);
				if (dataView.getUint8(idx) == 0x0D) {
					break;
				}
			}
		} catch (err) {
			end = true;
		}
		idx += 1;
		let propertiesArray = [];
		for (let i = 0; i < numberOfRecords; i++) {
			let properties: any = {};
			if (!end) {
				try {
					idx += 1;
					for (let j = 0; j < fields.length; j++) {
						let str = "";
						// if (this.#configuration?.iconvLiteDecodeFn && this.#configuration?.inputEncoding) {
						// 	let buffer = [];
						// 	for (let h = 0; h < fields[j].fieldLength; h++) {
						// 		buffer.push(dataView.getUint8(idx));
						// 		idx += 1;
						// 	}
						// 	str = this.#configuration?.iconvLiteDecodeFn(buffer, this.#configuration?.inputEncoding)
						// } else {
							let charString = [];
							for (let h = 0; h < fields[j].fieldLength; h++) {
								charString.push(String.fromCharCode(dataView.getUint8(idx)));
								idx += 1;
							}
							str = charString.join("");
						// }
						if (this.#configuration?.trim !== false) {
							str = str.split("").filter(char => char.codePointAt(0)).join("").trim();
						}
						const number = parseFloat(str);
						if (isNaN(number)) {
							properties[fields[j].name] = str;
						} else {
							properties[fields[j].name] = number;
						}
					}
				} catch (err) {
					end = true;
				}
			}
			propertiesArray.push(properties);
		}
		this.#propertiesArray = propertiesArray;
	}

	#geoJSON() {
    let wkt_crs = this.#prj?.toString('ascii') || 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
    let crs = prj2epsg.fromPRJ(wkt_crs);
    let crs_str = crs ? `urn:ogc:def:crs:EPSG::${crs}` : 'EPSG:4326'
    const geojson: any = {
      "crs": {
        "type": "name",
        "properties": {
          "name": `${crs_str}`
        }
      },
      "type": "FeatureCollection",
      "features": []
    };
    for (let i = 0; i < Math.min(this.#features.length, this.#propertiesArray.length); i++) {
      geojson.features.push({
        "type": "Feature",
        "geometry": this.#features[i],
        "properties": this.#propertiesArray[i]
      });
    }

    return geojson;
  }

	parse(): GeoJSON {
		this.#parseShp();
		this.#parseDbf();

		return this.#geoJSON();
	}
}

/**
 * Parses `shp` & `dbf` files into a GeoJSON object.
 * @param shpFile The path to the `shp` file.
 * @param dbfFile The path to the `dbf` file.
 * @param prjFile The path to the `prj` file.
 * @param configuration The configuration settings to use.
 * @returns A promise containing the GeoJSON object.
 */
export const parseFiles = async (shpFile: string | Buffer, dbfFile: string | Buffer, prjFile: string | Buffer, configuration?: Configuration): Promise<GeoJSON> => {
	if (typeof shpFile === "string") {
		shpFile = await fs.readFile(shpFile);
	}
	if (typeof dbfFile === "string") {
		dbfFile = await fs.readFile(dbfFile);
	}
	if (typeof prjFile === "string") {
    prjFile = await fs.readFile(prjFile);
	}

	return new Parser(shpFile, dbfFile, prjFile, configuration).parse();
};
